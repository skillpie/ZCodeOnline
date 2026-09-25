// 数据面通道：宿主控制通道 + 浏览器拼接管道（specs/web-tunnel.md §3.1-§3.2）。
// 管道内业务字节对 relay 不透明（端到端加密在两端完成），relay 只搬运密文与转发控制帧；
// 宿主认领拼接流靠一次性 streamId 能力（122-bit 随机、5 秒内未认领即作废）。
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import {
  TUNNEL_CONSTANTS,
  TUNNEL_PROTOCOL_VERSION,
  generateTunnelSecret,
  hashTunnelSecret,
  hostControlFrameSchema,
  tunnelClientHelloSchema,
  type HostControlFrame,
  type TunnelErrorCode,
} from "@zcode/shared";
import { createRelayLogger, type RelayLogger } from "./relayLog.js";
import {
  AssistInvitationStore,
  BindingStore,
  ConnectTokenStore,
  HostRegistry,
  PairingTokenStore,
  RouteTable,
} from "./tunnelStore.js";

const STREAM_CLAIM_TIMEOUT_MS = 5_000;

interface PendingStream {
  hostId: string;
  browserWs: WebSocket;
  claimTimer: NodeJS.Timeout;
}

interface AttachedStream {
  hostId: string;
  browserWs: WebSocket;
  hostWs: WebSocket;
}

export interface RelayChannels {
  handleHostConnection(ws: WebSocket): void;
  handleHostStreamConnection(ws: WebSocket, streamId: string): void;
  handleBrowserConnection(ws: WebSocket, hostId: string): void;
  /** 吊销/控制通道断开辅助：关闭某宿主的全部拼接流（浏览器侧收到 hostOffline）。 */
  closeHostStreams(hostId: string): void;
  /** 心跳扫描启动；返回清理函数。 */
  startHeartbeatSweep(): () => void;
}

export interface RelayChannelsOptions {
  now?: () => number;
  pairingTokens: PairingTokenStore;
  connectTokens: ConnectTokenStore;
  bindings: BindingStore;
  hosts: HostRegistry;
  assistInvitations: AssistInvitationStore;
  log?: RelayLogger;
}

function sendJson(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function closeWithHostError(ws: WebSocket, code: TunnelErrorCode, message?: string): void {
  sendJson(ws, { type: "error", code, ...(message ? { message } : {}) });
  ws.close(1008, code);
}

export function createRelayChannels(options: RelayChannelsOptions): RelayChannels {
  const now = options.now ?? Date.now;
  const log = options.log ?? createRelayLogger("relay-channels");
  const routes = new RouteTable<WebSocket>();
  const lastSeen = new Map<WebSocket, number>();
  const pendingStreams = new Map<string, PendingStream>();
  const attachedStreams = new Map<string, AttachedStream>();

  const touch = (ws: WebSocket): void => {
    lastSeen.set(ws, now());
  };

  function dropPendingStream(streamId: string, notifyBrowser: boolean): void {
    const pending = pendingStreams.get(streamId);
    if (!pending) return;
    clearTimeout(pending.claimTimer);
    pendingStreams.delete(streamId);
    if (notifyBrowser) {
      closeWithHostError(pending.browserWs, "hostOffline", "Host did not claim the stream");
    }
  }

  function teardownAttachedStream(streamId: string, keep: WebSocket): void {
    const attached = attachedStreams.get(streamId);
    if (!attached) return;
    attachedStreams.delete(streamId);
    const other = keep === attached.browserWs ? attached.hostWs : attached.browserWs;
    if (other.readyState <= other.OPEN) other.close(1001, "Peer closed");
  }

  function forwardBinary(from: WebSocket, to: WebSocket): void {
    from.on("message", (data: RawData, isBinary: boolean) => {
      // 管道建立后只允许二进制密文；text 帧视为契约破坏。
      if (!isBinary) {
        to.close(1003, "Data channel is binary-only after handshake");
        from.close(1003, "Data channel is binary-only after handshake");
        return;
      }
      if (to.readyState === to.OPEN) to.send(data, { binary: true });
    });
  }

  const channels: RelayChannels = {
    handleHostConnection(ws: WebSocket): void {
      let hostId: string | null = null;
      touch(ws);

      async function handleHostFrame(socket: WebSocket, frame: HostControlFrame): Promise<void> {
        if (frame.type === "ping") {
          sendJson(socket, { type: "pong", sentAt: frame.sentAt });
          return;
        }
        if (frame.type === "assistRegister") {
          if (hostId === null) {
            socket.close(1003, "Host must send hostHello first");
            return;
          }
          options.assistInvitations.register(
            frame.assistCodeHash,
            { hostId, maskedPsk: frame.maskedPsk },
            frame.expiresAt,
            now(),
          );
          log.info("assist invitation registered", {
            hostId,
            expiresInMs: frame.expiresAt - now(),
          });
          return;
        }
        if (frame.type === "pairingTokenRegister") {
          if (hostId === null) {
            socket.close(1003, "Host must send hostHello first");
            return;
          }
          options.pairingTokens.register(frame.pairingTokenHash, hostId, frame.expiresAt, now());
          log.info("pairing token registered", {
            hostId,
            expiresInMs: frame.expiresAt - now(),
          });
          return;
        }
        // hostHello：首连凭证为空 = 注册并签发；否则校验哈希。
        if (frame.protocolVersion !== TUNNEL_PROTOCOL_VERSION) {
          closeWithHostError(socket, "protocolMismatch", `Expect v${TUNNEL_PROTOCOL_VERSION}`);
          return;
        }
        let issuedCredential = "";
        if (frame.hostCredential === "") {
          // fail-closed：空凭证仅可注册未知 hostId。合法场景 = relay 重启清空注册表后
          // 宿主以空凭证重注册（自愈）；已知 hostId 拒绝空凭证，防止抢注顶替真实宿主。
          if (options.hosts.get(frame.hostId)) {
            closeWithHostError(socket, "invalidHostCredential");
            return;
          }
          issuedCredential = generateTunnelSecret();
          options.hosts.register({
            hostId: frame.hostId,
            hostCredentialHash: await hashTunnelSecret(issuedCredential),
            displayName: frame.displayName,
          });
        } else {
          const registered = options.hosts.get(frame.hostId);
          const credentialHash = await hashTunnelSecret(frame.hostCredential);
          if (!registered || registered.hostCredentialHash !== credentialHash) {
            closeWithHostError(socket, "invalidHostCredential");
            return;
          }
        }
        log.info("host registered", {
          hostId: frame.hostId,
          freshRegistration: issuedCredential !== "",
        });
        hostId = frame.hostId;
        const previous = routes.setRoute(hostId, socket);
        if (previous && previous !== socket)
          previous.close(1000, "Superseded by a new host connection");
        sendJson(socket, {
          type: "hostReady",
          issuedHostCredential: issuedCredential,
          serverTime: now(),
        });
      }

      ws.on("message", (data: RawData, isBinary: boolean) => {
        touch(ws);
        if (isBinary) {
          ws.close(1003, "Control channel is text-only");
          return;
        }
        const parsed = hostControlFrameSchema.safeParse(JSON.parse(String(data)));
        if (!parsed.success) {
          ws.close(1003, "Invalid control frame");
          return;
        }
        handleHostFrame(ws, parsed.data).catch(() => ws.close(1011, "Host frame handling failed"));
      });
      ws.on("close", () => {
        lastSeen.delete(ws);
        if (hostId === null) return;
        // 只有当前路由是本连接时才摘除，避免误删顶替后的新连接。
        routes.removeRoute(hostId, ws);
        channels.closeHostStreams(hostId);
      });
    },

    handleHostStreamConnection(ws: WebSocket, streamId: string): void {
      const pending = pendingStreams.get(streamId);
      if (!pending) {
        ws.close(1008, "Unknown or expired stream");
        return;
      }
      clearTimeout(pending.claimTimer);
      pendingStreams.delete(streamId);
      const attached: AttachedStream = {
        hostId: pending.hostId,
        browserWs: pending.browserWs,
        hostWs: ws,
      };
      attachedStreams.set(streamId, attached);
      sendJson(pending.browserWs, { type: "tunnelConnected", streamId });
      forwardBinary(pending.browserWs, ws);
      forwardBinary(ws, pending.browserWs);

      // 流级 keepalive：喂饱 nginx/中间设备的空闲定时器（对端 ws 自动回 pong）。
      const streamKeepalive = setInterval(() => {
        for (const socket of [pending.browserWs, ws]) {
          if (socket.readyState === socket.OPEN) socket.ping();
        }
      }, 20_000);
      streamKeepalive.unref();
      const clearKeepalive = (): void => clearInterval(streamKeepalive);
      pending.browserWs.once("close", clearKeepalive);
      ws.once("close", clearKeepalive);
      pending.browserWs.on("close", (code, reason) => {
        log.warn("assist/tunnel stream closed", {
          streamId,
          side: "browser",
          code,
          reason: String(reason).slice(0, 60),
        });
        teardownAttachedStream(streamId, ws);
      });
      pending.browserWs.on("error", (error: Error) => {
        log.warn("stream browser error", { streamId, error: error.message });
        teardownAttachedStream(streamId, ws);
      });
      ws.on("close", (code, reason) => {
        log.warn("assist/tunnel stream closed", {
          streamId,
          side: "host",
          code,
          reason: String(reason).slice(0, 60),
        });
        teardownAttachedStream(streamId, pending.browserWs);
      });
      ws.on("error", (error: Error) => {
        log.warn("stream host error", { streamId, error: error.message });
        teardownAttachedStream(streamId, pending.browserWs);
      });
    },

    handleBrowserConnection(ws: WebSocket, hostId: string): void {
      // hello 处理器在握手完成后必须自摘：拼接管道建立后该 socket 只承载二进制密文，
      // 残留的处理器会把第一个业务帧误判为"未握手"而断连。
      const onHello = (data: RawData, isBinary: boolean): void => {
        if (isBinary) {
          ws.close(1003, "Send tunnelClientHello first");
          return;
        }
        const hello = tunnelClientHelloSchema.safeParse(JSON.parse(String(data)));
        if (!hello.success) {
          closeWithHostError(ws, "connectTokenInvalid", "Malformed hello");
          return;
        }
        if (
          hello.data.protocolVersion !== TUNNEL_PROTOCOL_VERSION ||
          hello.data.hostId !== hostId
        ) {
          closeWithHostError(ws, "protocolMismatch");
          return;
        }
        ws.off("message", onHello);
        (async () => {
          const tokenHash = await hashTunnelSecret(hello.data.connectToken);
          const record = options.connectTokens.consume(tokenHash, now());
          if (
            !record ||
            record.hostId !== hostId ||
            !options.bindings.isBound(record.user, hostId)
          ) {
            closeWithHostError(ws, "invalidSessionCredential");
            return;
          }
          const route = routes.getRoute(hostId);
          if (!route) {
            closeWithHostError(ws, "hostOffline");
            return;
          }
          const streamId = randomUUID();
          const claimTimer = setTimeout(() => {
            dropPendingStream(streamId, true);
          }, STREAM_CLAIM_TIMEOUT_MS);
          pendingStreams.set(streamId, { hostId, browserWs: ws, claimTimer });
          sendJson(route, { type: "streamOpen", streamId });
        })().catch(() => ws.close(1011, "Hello handling failed"));
      };
      ws.on("message", onHello);
      ws.on("close", () => {
        for (const [streamId, attached] of attachedStreams) {
          if (attached.browserWs === ws) teardownAttachedStream(streamId, attached.hostWs);
        }
        for (const [streamId, pending] of pendingStreams) {
          if (pending.browserWs === ws) dropPendingStream(streamId, false);
        }
      });
    },

    closeHostStreams(hostId: string): void {
      for (const [streamId, attached] of attachedStreams) {
        if (attached.hostId !== hostId) continue;
        closeWithHostError(attached.browserWs, "hostOffline");
        if (attached.hostWs.readyState <= attached.hostWs.OPEN) {
          attached.hostWs.close(1001, "Host revoked");
        }
        attachedStreams.delete(streamId);
      }
      for (const [streamId, pending] of pendingStreams) {
        if (pending.hostId === hostId) dropPendingStream(streamId, true);
      }
    },

    startHeartbeatSweep(): () => void {
      const timer = setInterval(() => {
        const currentTime = now();
        for (const [ws, seen] of lastSeen) {
          if (currentTime - seen > TUNNEL_CONSTANTS.heartbeatTimeoutMs) {
            ws.close(1001, "Heartbeat timeout");
          }
        }
      }, TUNNEL_CONSTANTS.heartbeatIntervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };

  return channels;
}
