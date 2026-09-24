// 宿主出站隧道连接器（specs/web-tunnel.md §3.2）。
// 出站拨号 relay（用户机器不开入站端口）；拼接流内的业务字节端到端加密，
// 连接器解密后按 WS 消息 1:1 转发给本机 loopback 业务服务（/ws，replayable 档）。
// 断线重连：指数退避 + 抖动；心跳 ping/pong 超时即认为链路死亡。
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  TUNNEL_CONSTANTS,
  TUNNEL_PROTOCOL_VERSION,
  deriveTunnelKeys,
  e2eHelloFrameSchema,
  relayHostFrameSchema,
  TunnelCipher,
  type RelayHostFrame,
} from "@zcode/shared";

export type TunnelConnectorEvent =
  | { kind: "connecting" }
  | { kind: "connected"; serverTime: number }
  | { kind: "disconnected" }
  | { kind: "reconnecting"; delayMs: number }
  | { kind: "streamOpened"; streamId: string }
  | { kind: "streamClosed"; streamId: string }
  | { kind: "error"; message: string };

export interface TunnelConnectorOptions {
  relayUrl: string;
  hostId: string;
  /** 启动时读本地存储；首连为空串，hostReady 下发后经 onCredentialIssued 回存。 */
  hostCredential: string;
  displayName: string;
  psk: string;
  /** 拼接流的明文业务去向：本机 loopback 业务服务的 ws 地址。 */
  loopbackWsUrl: string;
  onCredentialIssued?: (credential: string) => void;
  onEvent?: (event: TunnelConnectorEvent) => void;
}

interface ActiveStream {
  streamId: string;
  relayStream: WebSocket;
  loopback: WebSocket;
  /** 拼接后的第一条密文必须是 e2e-hello；消费后才放行业务帧，防错配密钥污染业务流。 */
  handshakeDone: boolean;
}

interface PendingPairingToken {
  hash: string;
  expiresAt: number;
}

export class TunnelConnector {
  private control: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastRelayActivityAt = 0;
  private reconnectAttempt = 0;
  private streams = new Map<string, ActiveStream>();
  private pendingPairingToken: PendingPairingToken | null = null;
  private credential: string;

  constructor(private readonly options: TunnelConnectorOptions) {
    this.credential = options.hostCredential;
  }

  /** 宿主 PSK（进配对二维码，浏览器用于派生端到端密钥）。 */
  get psk(): string {
    return this.options.psk;
  }

  get relayUrl(): string {
    return this.options.relayUrl;
  }

  start(): void {
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const [streamId, stream] of this.streams) {
      stream.relayStream.close();
      stream.loopback.close();
      this.streams.delete(streamId);
    }
    this.control?.close();
    this.control = null;
  }

  /** 配对模块调用：登记待生效的一次性配对 token（哈希）；hostReady 后自动补发。 */
  setPairingToken(pairingTokenHash: string, expiresAt: number): void {
    this.pendingPairingToken = { hash: pairingTokenHash, expiresAt };
    this.sendControl({ type: "pairingTokenRegister", pairingTokenHash, expiresAt });
  }

  clearPairingToken(): void {
    this.pendingPairingToken = null;
  }

  private sendControl(frame: Record<string, unknown>): void {
    if (this.control?.readyState === WebSocket.OPEN) {
      this.control.send(JSON.stringify(frame));
    }
  }

  private emit(event: TunnelConnectorEvent): void {
    this.options.onEvent?.(event);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(
      TUNNEL_CONSTANTS.reconnectInitialMs * 2 ** this.reconnectAttempt,
      TUNNEL_CONSTANTS.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    // 指数退避 + 抖动：relay 重启后的惊群在 M4 参数化削峰，这里先保证不踩同一节奏。
    const jitter = randomBytes(4).readUInt32BE(0) % Math.max(base / 2, 1);
    const delayMs = base / 2 + jitter;
    this.emit({ kind: "reconnecting", delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delayMs);
  }

  private dial(): void {
    if (this.stopped) return;
    this.emit({ kind: "connecting" });
    const ws = new WebSocket(`${this.options.relayUrl}/ws/host`);
    this.control = ws;
    this.lastRelayActivityAt = Date.now();

    ws.on("open", () => {
      this.lastRelayActivityAt = Date.now();
      ws.send(
        JSON.stringify({
          type: "hostHello",
          hostId: this.options.hostId,
          hostCredential: this.credential,
          displayName: this.options.displayName,
          protocolVersion: TUNNEL_PROTOCOL_VERSION,
        }),
      );
    });

    ws.on("message", (data, isBinary) => {
      this.lastRelayActivityAt = Date.now();
      if (isBinary) {
        ws.close(1003, "Control channel is text-only");
        return;
      }
      const frame = relayHostFrameSchema.safeParse(JSON.parse(String(data)));
      if (!frame.success) {
        ws.close(1003, "Invalid control frame");
        return;
      }
      this.handleControlFrame(frame.data);
    });

    ws.on("close", () => {
      if (this.control === ws) this.control = null;
      this.clearTimers();
      for (const [streamId, stream] of this.streams) {
        stream.relayStream.close();
        stream.loopback.close();
        this.streams.delete(streamId);
      }
      if (!this.stopped) {
        this.emit({ kind: "disconnected" });
        this.scheduleReconnect();
      }
    });
    ws.on("error", () => ws.terminate());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      // 只发不收超过超时窗即视为链路死亡，主动断开触发退避重连。
      if (Date.now() - this.lastRelayActivityAt > TUNNEL_CONSTANTS.heartbeatTimeoutMs) {
        this.control?.terminate();
        return;
      }
      this.sendControl({ type: "ping", sentAt: Date.now() });
    }, TUNNEL_CONSTANTS.heartbeatIntervalMs);
  }

  private handleControlFrame(frame: RelayHostFrame): void {
    if (frame.type === "hostReady") {
      this.reconnectAttempt = 0;
      if (frame.issuedHostCredential) {
        this.credential = frame.issuedHostCredential;
        this.options.onCredentialIssued?.(frame.issuedHostCredential);
      }
      this.startHeartbeat();
      // 控制通道每次就绪（含重连）都补登记配对 token，扫码期间的 relay 重启不破坏配对。
      if (this.pendingPairingToken && this.pendingPairingToken.expiresAt > Date.now()) {
        this.sendControl({
          type: "pairingTokenRegister",
          pairingTokenHash: this.pendingPairingToken.hash,
          expiresAt: this.pendingPairingToken.expiresAt,
        });
      }
      this.emit({ kind: "connected", serverTime: frame.serverTime });
      return;
    }
    if (frame.type === "streamOpen") {
      void this.openStream(frame.streamId);
      return;
    }
    if (frame.type === "streamClosed") {
      const stream = this.streams.get(frame.streamId);
      if (stream) {
        this.streams.delete(frame.streamId);
        stream.relayStream.close();
        stream.loopback.close();
        this.emit({ kind: "streamClosed", streamId: frame.streamId });
      }
      return;
    }
    if (frame.type === "error") {
      this.emit({
        kind: "error",
        message: `relay: ${frame.code}${frame.message ? ` ${frame.message}` : ""}`,
      });
    }
  }

  /** 打开一条拼接流：relay 侧密文 ⇄ 解密 ⇄ 本机 loopback 业务 WS。 */
  private async openStream(streamId: string): Promise<void> {
    let keys;
    try {
      keys = await deriveTunnelKeys(this.options.psk, this.options.hostId);
    } catch (error) {
      this.emit({ kind: "error", message: `key derivation failed: ${String(error)}` });
      return;
    }
    const hostRecv = new TunnelCipher(keys.clientToHost, "clientToHost");
    const hostSend = new TunnelCipher(keys.hostToClient, "hostToClient");

    const relayStream = new WebSocket(`${this.options.relayUrl}/ws/host/stream/${streamId}`);
    const loopback = new WebSocket(this.options.loopbackWsUrl);
    const stream: ActiveStream = { streamId, relayStream, loopback, handshakeDone: false };

    const teardown = (): void => {
      if (!this.streams.delete(streamId)) return;
      this.emit({ kind: "streamClosed", streamId });
      if (relayStream.readyState === WebSocket.OPEN) relayStream.close(1000);
      if (loopback.readyState <= WebSocket.OPEN) loopback.close(1000);
    };
    relayStream.on("close", teardown);
    relayStream.on("error", () => relayStream.terminate());
    loopback.on("close", teardown);
    loopback.on("error", () => loopback.terminate());

    try {
      await Promise.all([onceOpen(relayStream), onceOpen(loopback)]);
    } catch {
      relayStream.terminate();
      loopback.terminate();
      this.emit({ kind: "error", message: `stream ${streamId} dial failed` });
      return;
    }
    this.streams.set(streamId, stream);
    this.emit({ kind: "streamOpened", streamId });

    const handleRelayMessage = async (
      cipherBytes: Uint8Array,
      isBinary: boolean,
    ): Promise<void> => {
      if (!isBinary) {
        teardown();
        return;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await hostRecv.decrypt(cipherBytes);
      } catch {
        this.emit({ kind: "error", message: `stream ${streamId} decrypt failed (psk mismatch?)` });
        teardown();
        return;
      }
      if (!stream.handshakeDone) {
        const helloFrame = e2eHelloFrameSchema.safeParse(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
        if (!helloFrame.success) {
          this.emit({ kind: "error", message: `stream ${streamId} bad e2e handshake` });
          teardown();
          return;
        }
        stream.handshakeDone = true;
        return;
      }
      if (loopback.readyState === WebSocket.OPEN) loopback.send(plaintext, { binary: true });
    };

    // E2E 握手：宿主先发 e2e-hello，浏览器回 e2e-hello 后才放行业务帧。
    const hello = new TextEncoder().encode(
      JSON.stringify({ type: "e2e-hello", protocolVersion: TUNNEL_PROTOCOL_VERSION }),
    );
    relayStream.send(Buffer.from(await hostSend.encrypt(hello)), { binary: true });

    relayStream.on("message", (data, isBinary) => {
      void handleRelayMessage(new Uint8Array(data as Buffer), isBinary);
    });

    loopback.on("message", (data) => {
      void hostSend
        .encrypt(new Uint8Array(data as Buffer))
        .then((frame) => {
          if (relayStream.readyState === WebSocket.OPEN) {
            relayStream.send(Buffer.from(frame), { binary: true });
          }
        })
        .catch(teardown);
    });
  }
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}
