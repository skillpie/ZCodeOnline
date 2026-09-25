// 宿主出站隧道连接器（specs/web-tunnel.md §3.2）。
// 出站拨号 relay（用户机器不开入站端口）；拼接流内的业务字节端到端加密，
// 连接器解密后按 WS 消息 1:1 转发给本机 loopback 业务服务（/ws，replayable 档）。
// 断线重连：指数退避 + 抖动；心跳 ping/pong 超时即认为链路死亡。
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  TUNNEL_ASSIST_TTL_MS,
  TUNNEL_CONSTANTS,
  TUNNEL_PROTOCOL_VERSION,
  deriveTunnelKeys,
  e2eHelloFrameSchema,
  generateAssistCode,
  generateTunnelSecret,
  hashTunnelSecret,
  maskAssistPsk,
  relayHostFrameSchema,
  tunnelBootstrapFrameSchema,
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
  /** relay 侧凭证失效（relay 重启清空注册表）：调用方应清掉持久化凭证，连接器将以空凭证重注册。 */
  onCredentialInvalid?: () => void;
  /** 持久机器码初值（来自 state.json）：跨重启稳定，链接长期有效。 */
  initialAssist?: { code: string; psk: string };
  /** 远程码生成/轮换时回存（调用方持久化到 state.json）。 */
  onAssistChange?: (assist: { code: string; psk: string; expiresAt: number }) => void;
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

interface ActiveAssistInvitation {
  code: string;
  codeHash: string;
  maskedPsk: string;
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
  private activeAssist: ActiveAssistInvitation | null = null;
  private credential: string;
  /** 每次成功 hostReady 前最多自愈一次：避免对端持续拒绝时空转清凭证。 */
  private reregisterPending = false;

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

  /** 远程协助：取当前机器码（持久化，无则生成并登记）；宿主重连自动补登记。 */
  async ensureAssistCode(): Promise<{ code: string; expiresAt: number }> {
    if (!this.activeAssist) {
      await this.regenerateAssistCode();
    }
    return { code: this.activeAssist!.code, expiresAt: this.activeAssist!.expiresAt };
  }

  /** 轮换：作废旧码，生成新码（新 PSK）重新登记并持久化。 */
  async regenerateAssistCode(): Promise<{ code: string; expiresAt: number }> {
    const code = generateAssistCode();
    const psk = generateTunnelSecret();
    const maskedPsk = await maskAssistPsk(psk, code);
    const expiresAt = Date.now() + TUNNEL_ASSIST_TTL_MS;
    const codeHash = await hashTunnelSecret(code);
    this.activeAssist = { code, codeHash, maskedPsk, expiresAt };
    this.options.onAssistChange?.({ code, psk, expiresAt });
    this.sendControl({
      type: "assistRegister",
      assistCodeHash: codeHash,
      maskedPsk,
      expiresAt,
    });
    return { code, expiresAt };
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

    ws.on("close", (code, reason) => {
      this.emit({
        kind: "error",
        message: `control closed: code=${code} reason=${String(reason).slice(0, 80)}`,
      });
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
      this.reregisterPending = false;
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
      // 远程协助机器码随 hostReady 补登记（relay 重启后码不变 = 链接长期有效）。
      void (async () => {
        if (!this.activeAssist && this.options.initialAssist) {
          const { code, psk } = this.options.initialAssist;
          this.activeAssist = {
            code,
            codeHash: await hashTunnelSecret(code),
            maskedPsk: await maskAssistPsk(psk, code),
            expiresAt: Date.now() + TUNNEL_ASSIST_TTL_MS,
          };
        }
        if (this.activeAssist) {
          this.sendControl({
            type: "assistRegister",
            assistCodeHash: this.activeAssist.codeHash,
            maskedPsk: this.activeAssist.maskedPsk,
            expiresAt: this.activeAssist.expiresAt,
          });
        }
      })();
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
      if (
        frame.code === "invalidHostCredential" &&
        this.credential !== "" &&
        !this.reregisterPending
      ) {
        // relay 重启清空注册表后，持久化凭证必然失效：清凭证、以空凭证重注册自愈。
        // relay 侧 fail-closed 保证这只会发生在 hostId 未被抢注时。
        this.reregisterPending = true;
        this.credential = "";
        this.reconnectAttempt = 0;
        this.options.onCredentialInvalid?.();
        this.control?.terminate();
      }
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

    // 双向接线挂在拨号时而非 open 之后：服务器的 Initialize 帧与 WS open 在同一数据块/
    // 同一宏任务里到达，Promise.all 的微任务续体永远晚于它——晚挂的监听器会永久丢帧，
    // 浏览器 RPC 状态机等不到 Initialize（所有请求挂在 whenInitialized，应用白屏）。
    // loopback 侧先入缓冲，bootstrap 帧发出后按序 flush，保证帧序 = e2e-hello → bootstrap → 业务帧。
    // 加密异步完成顺序不定：两个方向都必须按帧到达序串行化，乱序帧会被对端
    // 序号守卫拒绝（或字节流错乱）。outbound 缓冲期的 pendingOut flush 同样按序。
    const pendingOut: Buffer[] = [];
    let outboundOpen = false;
    let outboundChain: Promise<void> = Promise.resolve();
    const sendOutbound = (plain: Uint8Array): void => {
      outboundChain = outboundChain
        .then(async () => {
          const frame = await hostSend.encrypt(plain);
          if (relayStream.readyState === WebSocket.OPEN) {
            relayStream.send(Buffer.from(frame), { binary: true });
          }
        })
        .catch(teardown);
    };
    loopback.on("message", (data) => {
      const bytes = new Uint8Array(data as Buffer);
      if (outboundOpen) {
        sendOutbound(bytes);
      } else {
        pendingOut.push(Buffer.from(bytes));
      }
    });
    const handleRelayMessage = async (
      cipherBytes: Uint8Array,
      isBinary: boolean,
    ): Promise<void> => {
      if (!isBinary) {
        this.emit({ kind: "error", message: `DBG stream ${streamId} TEXT frame from browser (contract break)` });
        teardown();
        return;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await hostRecv.decrypt(cipherBytes);
      } catch (error) {
        this.emit({ kind: "error", message: `DBG stream ${streamId} decrypt failed: ${String(error).slice(0, 100)}` });
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
      this.emit({
        kind: "error",
        message: `DBG ${new Date().toISOString()} browser->loopback ${plaintext.byteLength}B`,
      });
      if (loopback.readyState === WebSocket.OPEN) loopback.send(plaintext, { binary: true });
    };
    let inboundChain: Promise<void> = Promise.resolve();
    relayStream.on("message", (data, isBinary) => {
      this.emit({
        kind: "error",
        message: `DBG ${new Date().toISOString()} relay->loopback ${(data as Buffer).length}B bin=${isBinary}`,
      });
      inboundChain = inboundChain
        .then(() => handleRelayMessage(new Uint8Array(data as Buffer), isBinary))
        .catch((error: unknown) => {
          this.emit({
            kind: "error",
            message: `DBG ${new Date().toISOString()} inbound chain threw: ${String(error).slice(0, 120)}`,
          });
          return undefined;
        });
    });

    const teardown = (): void => {
      if (!this.streams.delete(streamId)) return;
      this.emit({ kind: "streamClosed", streamId });
      if (relayStream.readyState === WebSocket.OPEN) relayStream.close(1000);
      if (loopback.readyState <= WebSocket.OPEN) loopback.close(1000);
    };
    relayStream.on("close", (code, reason) => {
      this.emit({
        kind: "error",
        message: `DBG stream ${streamId} relayStream closed: code=${code} reason=${String(reason).slice(0, 80)}`,
      });
      teardown();
    });
    relayStream.on("error", (error: Error) => {
      this.emit({ kind: "error", message: `DBG stream ${streamId} relayStream error: ${error.message}` });
      relayStream.terminate();
    });
    loopback.on("close", (code, reason) => {
      this.emit({
        kind: "error",
        message: `DBG stream ${streamId} loopback closed: code=${code} reason=${String(reason).slice(0, 80)}`,
      });
      teardown();
    });
    loopback.on("error", (error: Error) => {
      this.emit({ kind: "error", message: `DBG stream ${streamId} loopback error: ${error.message}` });
      loopback.terminate();
    });

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

    // 流级 keepalive：空闲期 nginx send/read 定时器与中间设备会静默切断 TCP（1006），
    // 协议层 ping 喂饱两侧定时器（relay 的 ws 服务端自动回 pong）。
    const keepalive = setInterval(() => {
      if (relayStream.readyState === WebSocket.OPEN) relayStream.ping();
    }, 20_000);
    keepalive.unref();
    relayStream.once("close", () => clearInterval(keepalive));

    // E2E 握手：宿主先发 e2e-hello，浏览器回 e2e-hello 后才放行业务帧。
    const hello = new TextEncoder().encode(
      JSON.stringify({ type: "e2e-hello", protocolVersion: TUNNEL_PROTOCOL_VERSION }),
    );
    relayStream.send(Buffer.from(await hostSend.encrypt(hello)), { binary: true });

    // bootstrap：隧道只承载 WS RPC，浏览器拿不到同源 /api/server-info（workspace 注入依赖它）。
    await sendBootstrapFrame(this.options.loopbackWsUrl, relayStream, hostSend);
    outboundOpen = true;
    while (pendingOut.length > 0) {
      sendOutbound(new Uint8Array(pendingOut.shift()!));
    }
  }
}

/**
 * 取本机 loopback server 的 /api/server-info 并作为 bootstrap 帧下发。
 * 失败/超时不阻塞隧道（浏览器按无 bootstrap 继续，与旧版宿主兼容）。
 */
async function sendBootstrapFrame(
  loopbackWsUrl: string,
  relayStream: WebSocket,
  hostSend: TunnelCipher,
): Promise<void> {
  try {
    // loopbackWsUrl 形如 ws://127.0.0.1:3030/ws；server-info 在同一 HTTP 源上。
    const httpOrigin = new URL(loopbackWsUrl).origin.replace(/^ws/u, "http");
    const response = await fetch(`${httpOrigin}/api/server-info`, {
      signal: AbortSignal.timeout(TUNNEL_CONSTANTS.bootstrapFetchTimeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return;
    const info = (await response.json()) as {
      workspaces?: Array<{ path?: unknown; workspaceIdentity?: unknown }>;
    };
    const workspaces = (Array.isArray(info.workspaces) ? info.workspaces : [])
      .filter(
        (entry): entry is { path: string; workspaceIdentity?: string } =>
          typeof entry?.path === "string" && entry.path.length > 0,
      )
      .slice(0, 16)
      .map((entry) => ({
        path: entry.path,
        ...(typeof entry.workspaceIdentity === "string"
          ? { workspaceIdentity: entry.workspaceIdentity }
          : {}),
      }));
    const frame = tunnelBootstrapFrameSchema.parse({ type: "tunnelBootstrap", workspaces });
    const cipherBytes = await hostSend.encrypt(new TextEncoder().encode(JSON.stringify(frame)));
    relayStream.send(Buffer.from(cipherBytes), { binary: true });
  } catch {
    // server-info 不可达 / 形状不符：跳过 bootstrap，浏览器侧按超时继续。
  }
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}
