// 浏览器侧隧道传输（specs/web-tunnel.md §3.4）：把 relay 拼接流包装成 v4 通道的 ISocket。
// 状态机：连接票据 → tunnelClientHello → tunnelConnected → e2e-hello 双向校验 → 业务帧放行。
// 业务帧一进一出都过 TunnelCipher；relay 全程只见密文与路由元数据。
import {
  TUNNEL_CONSTANTS,
  TUNNEL_PROTOCOL_VERSION,
  TunnelCipher,
  deriveTunnelKeys,
  e2eHelloFrameSchema,
  relayClientFrameSchema,
  tunnelBootstrapFrameSchema,
  tunnelClientHelloSchema,
  type TunnelErrorCode,
} from "@zcode/shared";
import { Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { connectViaProtocol, type WebSocketConnectionCloseEvent } from "@zcode/client";
import { relayHttpOrigin } from "./tunnelSession.js";

export class TunnelConnectError extends Error {
  constructor(
    message: string,
    readonly code: "credential" | "hostOffline" | "protocol" | "network" | string,
  ) {
    super(message);
    this.name = "TunnelConnectError";
  }
}

export interface TunnelTransportOptions {
  relayUrl: string;
  hostId: string;
  psk: string;
  /** 自机隧道：会话凭证换一次性连接票据。 */
  sessionCredential?: string;
  /** 远程协助：兑换端点已直接签发连接票据，跳过凭证换取。 */
  connectToken?: string;
  fetchImpl?: typeof fetch;
  /** 测试注入（node 环境用 ws 包适配层）；浏览器走全局 WebSocket。 */
  WebSocketImpl?: typeof WebSocket;
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
}

/** 宿主经 bootstrap 帧下发的 server-info 摘要（workspace 注入用）。 */
export interface TunnelBootstrap {
  workspaces: Array<{ path: string; workspaceIdentity?: string }>;
}

export interface TunnelTransport {
  socket: ISocket;
  close(): void;
  /** 旧版宿主不发 bootstrap 帧时为 undefined。 */
  bootstrap?: TunnelBootstrap;
}

/** WebSocket 连接已建立的 readyState 值；WS 实例上没有 OPEN 静态属性可比。 */
const WS_OPEN = 1;

function tunnelWsError(code: TunnelErrorCode | "protocol"): TunnelConnectError {
  if (code === "hostOffline") {
    return new TunnelConnectError("宿主机当前不在线，请确认本机 ZCode 正在运行后重试", code);
  }
  if (code === "invalidSessionCredential" || code === "connectTokenInvalid") {
    return new TunnelConnectError("会话已失效，请重新配对", code);
  }
  if (code === "protocolMismatch") {
    return new TunnelConnectError("客户端与宿主版本不匹配，请升级后重试", code);
  }
  return new TunnelConnectError(`连接被拒绝（${code}）`, code);
}

export async function connectTunnelTransport(
  options: TunnelTransportOptions,
): Promise<TunnelTransport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;

  // 1. 一次性连接票据：远程协助路径直接持有票据；自机隧道用会话凭证换取（不进 WS URL）。
  let connectToken: string;
  if (options.connectToken) {
    connectToken = options.connectToken;
  } else {
    try {
      const tokenResponse = await fetchImpl(
        `${relayHttpOrigin(options.relayUrl)}/api/v1/tunnel/connect-token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionCredential: options.sessionCredential }),
        },
      );
      if (!tokenResponse.ok) {
        throw tunnelWsError("invalidSessionCredential");
      }
      connectToken = ((await tokenResponse.json()) as { connectToken: string }).connectToken;
    } catch (error) {
      if (error instanceof TunnelConnectError) throw error;
      throw new TunnelConnectError("无法连接 relay 服务，请检查网络后重试", "network");
    }
  }

  // 2. 数据面 WS + hello/票据交换。
  const ws = new WebSocketImpl(`${options.relayUrl}/ws/tunnel/${options.hostId}`);
  ws.binaryType = "arraybuffer";

  // 接收缓冲 + 订阅即重放：服务器在连接建立瞬间就下发 Initialize 帧，而
  // SocketProtocol 在 transport 返回后才订阅 onData——Emitter 零订阅者的 fire 会丢帧，
  // 客户端 RPC 状态机将永远等不到 Initialize（所有请求挂在 whenInitialized，应用白屏）。
  const pendingIn: Uint8Array[] = [];
  const dataListeners = new Set<(data: VSBuffer) => void>();
  const deliverInbound = (plaintext: Uint8Array): void => {
    if (dataListeners.size === 0) {
      pendingIn.push(plaintext);
      return;
    }
    for (const listener of dataListeners) {
      listener(VSBuffer.wrap(plaintext));
    }
  };
  // 写串行队列：加密异步，并发 write 完成顺序不定，乱序帧会被对端序号守卫拒绝。
  let writeChain: Promise<void> = Promise.resolve();
  // 读串行队列：WS 帧按序到达，解密异步完成顺序不定，乱序 deliver 会打乱字节流。
  let readChain: Promise<void> = Promise.resolve();

  const onData: ISocket["onData"] = (listener) => {
    dataListeners.add(listener);
    // 首个订阅者触发缓冲重放（Initialize 等 pre-subscription 帧）；后订阅者只看后续帧，
    // 与 VSCode Event 广播语义一致。
    for (const buffered of pendingIn.splice(0)) {
      listener(VSBuffer.wrap(buffered));
    }
    return { dispose: () => dataListeners.delete(listener) };
  };
  const onCloseEvent = new Emitter<void>();

  // 致命错误通道：路由器的 fire-and-forget 处理器抛错不会自动传到外层 async 函数，
  // fail() 把错误记入 fatal 并唤醒两个等待门，由 await 点统一 rethrow 给调用方。
  let fatal: TunnelConnectError | null = null;
  function fail(error: TunnelConnectError): never {
    fatal = error;
    onCloseEvent.fire();
    handshakeResolve?.();
    bootstrapResolve?.();
    try {
      ws.close(1000, error.message);
    } catch {
      // 已关闭的 socket 再 close 会抛错；清理路径忽略即可。
    }
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("close", (event) => {
      options.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      reject(new TunnelConnectError("连接在握手完成前关闭", "network"));
    });
    ws.addEventListener("error", () => {
      reject(new TunnelConnectError("无法连接 relay 服务", "network"));
    });
  });

  ws.send(
    JSON.stringify(
      tunnelClientHelloSchema.parse({
        type: "tunnelClientHello",
        hostId: options.hostId,
        connectToken,
        protocolVersion: TUNNEL_PROTOCOL_VERSION,
      }),
    ),
  );

  // 3. 接收状态机：路由器在 WS 创建后立即挂载（先于任何 await）——宿主把 connected 应答、
  // bootstrap 与服务器的 Initialize 连续发送，任何"事后挂监听器"的窗口都会丢帧。
  // 阶段：connected(text 应答) → hostHello(e2e 握手) → bootstrap | 业务首帧 → open(业务流)。
  type ReceivePhase = "connected" | "hostHello" | "bootstrap" | "open";
  let phase: ReceivePhase = "connected";
  let bootstrap: TunnelBootstrap | undefined;
  let handshakeResolve: (() => void) | null = null;
  let bootstrapResolve: (() => void) | null = null;
  let e2eFailed = false;
  const handshakeReady = new Promise<void>((resolve) => (handshakeResolve = resolve));
  const bootstrapDone = new Promise<void>((resolve) => (bootstrapResolve = resolve));

  // 密钥派生异步进行；路由器在密钥就绪前收到的密文帧等待密钥就绪后处理。
  let browserSendRef: TunnelCipher | null = null;
  let browserRecvRef: TunnelCipher | null = null;
  const keysReady = deriveTunnelKeys(options.psk, options.hostId)
    .then((keys) => {
      browserSendRef = new TunnelCipher(keys.clientToHost, "clientToHost");
      browserRecvRef = new TunnelCipher(keys.hostToClient, "hostToClient");
    })
    .catch((error: unknown) => {
      fail(
        error instanceof TunnelConnectError
          ? error
          : new TunnelConnectError("密钥派生失败，请重新配对", "protocol"),
      );
    });

  ws.addEventListener("message", (event) => {
    readChain = readChain
      .then(async () => {
        const data: unknown = event.data;
        if (phase === "connected") {
          // relay 应答（text）：tunnelConnected 或错误帧。
          if (typeof data !== "string") {
            fail(new TunnelConnectError("握手时序错误", "protocol"));
            return;
          }
          const ack = relayClientFrameSchema.safeParse(JSON.parse(data));
          if (!ack.success || ack.data.type === "error") {
            const code = ack.success && ack.data.type === "error" ? ack.data.code : "protocol";
            fail(tunnelWsError(code));
            return;
          }
          phase = "hostHello";
          // ack 到达即发 e2e-hello（密钥就绪后；GCM 校验即 PSK 证明）。
          await keysReady;
          if (!browserSendRef || e2eFailed) return;
          const hello = new TextEncoder().encode(
            JSON.stringify(
              e2eHelloFrameSchema.parse({
                type: "e2e-hello",
                protocolVersion: TUNNEL_PROTOCOL_VERSION,
              }),
            ),
          );
          ws.send(new Uint8Array(await browserSendRef.encrypt(hello)));
          return;
        }
        if (typeof data === "string") {
          // 业务通道里的 text 帧视为契约破坏。
          console.error("[tunnel-die] text frame in business channel");
          onCloseEvent.fire();
          return;
        }
        await keysReady;
        if (!browserRecvRef) return;
        let plaintext: Uint8Array;
        try {
          plaintext = await browserRecvRef.decrypt(new Uint8Array(data as ArrayBuffer));
        } catch {
          // 握手阶段解密失败 = PSK 不匹配（对端用错误密钥加密）；业务阶段 = 流损坏。
          if (phase === "hostHello" || phase === "bootstrap") {
            fail(
              new TunnelConnectError("端到端握手失败（配对信息不匹配），请重新配对", "protocol"),
            );
            return;
          }
          console.error("[tunnel-die] decrypt failed in open phase");
          onCloseEvent.fire();
          return;
        }
        if (phase === "hostHello") {
          if (
            !e2eHelloFrameSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext))).success
          ) {
            e2eFailed = true;
            handshakeResolve?.();
            fail(
              new TunnelConnectError("端到端握手失败（配对信息不匹配），请重新配对", "protocol"),
            );
            return;
          }
          phase = "bootstrap";
          handshakeResolve?.();
          return;
        }
        if (phase === "bootstrap") {
          const parsed = tunnelBootstrapFrameSchema.safeParse(
            JSON.parse(new TextDecoder().decode(plaintext)),
          );
          if (parsed.success) {
            bootstrap = { workspaces: parsed.data.workspaces };
          } else {
            // 旧宿主不发 bootstrap：该帧是业务首帧（如 Initialize），回流业务通道。
            deliverInbound(plaintext);
          }
          phase = "open";
          bootstrapResolve?.();
          return;
        }
        deliverInbound(plaintext);
      })
      .catch((error: unknown) => {
        // 握手阶段 fail() 已把错误记入 fatal 并唤醒等待门；业务阶段断流静默关闭。
        if (error instanceof TunnelConnectError && fatal === error) return;
        console.error("[tunnel-die] router threw:", String(error).slice(0, 200));
        onCloseEvent.fire();
      });
  });

  // 业务阶段的对端断开：记录 close code/reason（诊断会话死亡归属）。
  ws.addEventListener("close", (event) => {
    if (phase === "open") {
      console.error(
        `[tunnel-die] ws closed post-handshake: code=${event.code} reason=${String(event.reason).slice(0, 80)} clean=${event.wasClean}`,
      );
    }
  });

  // 握手期间对端断开 = 大概率 PSK 不匹配（宿主解密 e2e-hello 失败即断流）。
  ws.addEventListener("close", () => {
    if (phase !== "open") {
      e2eFailed = true;
      handshakeResolve?.();
      bootstrapResolve?.();
      try {
        fail(
          new TunnelConnectError(
            "宿主机断开了握手连接：可能配对信息不匹配，请重新配对",
            "protocol",
          ),
        );
      } catch {
        // fail 在事件回调内 throw 仅记录 fatal；错误经 await 点 rethrow。
      }
    }
  });

  // 等待宿主 e2e-hello（有界）：超时或失败都按握手失败处理。
  await Promise.race([
    handshakeReady,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new TunnelConnectError("端到端握手超时", "network")),
        TUNNEL_CONSTANTS.bootstrapWaitTimeoutMs,
      ),
    ),
  ]).catch((error: unknown) => {
    fail(
      error instanceof TunnelConnectError ? error : new TunnelConnectError("握手失败", "protocol"),
    );
  });
  if (fatal) fail(fatal);
  if (e2eFailed) {
    fail(new TunnelConnectError("端到端握手失败（配对信息不匹配），请重新配对", "protocol"));
  }

  // 等待 bootstrap（有界）：旧宿主不发，超时按无 bootstrap 继续。
  await Promise.race([
    bootstrapDone,
    new Promise<void>((resolve) =>
      setTimeout(() => bootstrapResolve?.(), TUNNEL_CONSTANTS.bootstrapWaitTimeoutMs),
    ),
  ]);
  if (fatal) fail(fatal);

  const socket: ISocket = {
    onData,
    onClose: onCloseEvent.event,
    onEnd: onCloseEvent.event,
    write(buffer: VSBuffer) {
      // WebSocket.OPEN 是静态属性，实例上不存在——用字面量常量判断，实例比较恒 false 会静默丢帧。
      if (ws.readyState !== WS_OPEN) return;
      // 写路径按调用序串行化：帧序 = 调用序 = 加密序号序。
      writeChain = writeChain
        .then(async () => {
          await keysReady;
          const frame = await browserSendRef!.encrypt(buffer.buffer);
          ws.send(new Uint8Array(frame));
        })
        .catch((error: unknown) => {
          console.error("[tunnel-die] write failed:", String(error).slice(0, 150));
          onCloseEvent.fire();
        });
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };

  return {
    socket,
    bootstrap,
    close() {
      ws.close();
    },
  };
}

function nextTextFrame(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TunnelConnectError("握手超时", "network")), 10_000);
    const onMessage = (event: MessageEvent): void => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (typeof event.data === "string") {
        resolve(event.data);
      } else {
        reject(new TunnelConnectError("握手时序错误", "protocol"));
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new TunnelConnectError("连接已关闭", "network"));
    });
  });
}

function nextBinaryFrame(ws: WebSocket, timeoutMs = 10_000): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TunnelConnectError("端到端握手超时", "network")),
      timeoutMs,
    );
    const onMessage = (event: MessageEvent): void => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (typeof event.data !== "string") {
        resolve(event.data as ArrayBuffer);
      } else {
        reject(new TunnelConnectError("握手时序错误", "protocol"));
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      // 握手阶段被对端断开：绝大多数是宿主解密 e2e-hello 失败（PSK 不匹配）主动断连，
      // 其次是宿主机中途离线——统一引导重新配对，不猜测具体原因。
      reject(
        new TunnelConnectError("宿主机断开了握手连接：可能配对信息不匹配，请重新配对", "protocol"),
      );
    });
  });
}

/** 组装 v4 服务通道：加密 ISocket → SocketProtocol → ChannelClient。 */
export async function connectTunnelServices(options: TunnelTransportOptions): Promise<{
  services: ReturnType<typeof connectViaProtocol>;
  transport: TunnelTransport;
  bootstrap?: TunnelBootstrap;
}> {
  const transport = await connectTunnelTransport(options);
  const services = connectViaProtocol(new SocketProtocol(transport.socket));
  return { services, transport, bootstrap: transport.bootstrap };
}
