import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { VSBuffer } from "@zcode/rpc";
import {
  relayHttpOrigin,
  TUNNEL_PROTOCOL_VERSION,
  TunnelCipher,
  deriveTunnelKeys,
  e2eHelloFrameSchema,
  generateTunnelSecret,
} from "@zcode/shared";
import { connectTunnelTransport, TunnelConnectError } from "../src/tunnel/transport.js";

// 隧道客户端传输验收（specs/web-tunnel.md §3.4，Web 与桌面 renderer 共用实现）：
// relayHttpOrigin 转换、宿主离线的可读错误、凭证换票据 → 隧道握手 → bootstrap →
// 业务帧加解密回声、坏 PSK 与凭证失效的用户可见错误。

const HOST_ID = "h-client";
const PSK = generateTunnelSecret();
const VALID_CREDENTIAL = `cred-${randomUUID()}`;

/** DOM WebSocket 最小适配层：让 node 的 ws 包满足浏览器 WebSocket 用法（各自持有底层连接）。 */
class DomLikeWebSocket {
  static OPEN = 1;
  OPEN = 1;
  binaryType = "blob";
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private readonly socket: NodeWebSocket;

  constructor(url: string) {
    this.socket = new NodeWebSocket(url);
    this.socket.on("open", () => {
      this.readyState = 1;
      this.dispatch("open", {});
    });
    this.socket.on("message", (data, isBinary) => {
      const buffer = data as Buffer;
      this.dispatch("message", {
        data: isBinary
          ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
          : String(data),
      });
    });
    this.socket.on("close", (code, reason) => {
      this.readyState = 3;
      this.dispatch("close", { code, reason: String(reason) });
    });
    this.socket.on("error", () => this.dispatch("error", {}));
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.socket.send(data as never);
  }

  close(): void {
    this.socket.close();
  }
}

/** 供 connectTunnelTransport 的 WebSocketImpl 注入：类本身可被 new 调用。 */
function DomLikeWebSocketFactory(url: string): DomLikeWebSocket {
  return new DomLikeWebSocket(url);
}

async function createFakeRelay(): Promise<{
  wsUrl: string;
  close(): Promise<void>;
  setOnline(value: boolean): void;
}> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const keys = await deriveTunnelKeys(PSK, HOST_ID);
  const hostRecv = new TunnelCipher(keys.clientToHost, "clientToHost");
  const hostSend = new TunnelCipher(keys.hostToClient, "hostToClient");
  let online = true;
  let stage: "hello" | "handshake" | "open" = "hello";

  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/v1/tunnel/connect-token") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const parsed = JSON.parse(body) as { sessionCredential?: string };
        if (parsed.sessionCredential !== VALID_CREDENTIAL) {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: "invalidSessionCredential" }));
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ connectToken: `tok-${randomUUID()}`, expiresAt: Date.now() + 60_000 }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    })().catch(() => response.destroy());
  });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== `/ws/tunnel/${HOST_ID}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      stage = "hello";
      ws.on("message", (data, isBinary) => {
        void (async () => {
          if (!isBinary) {
            if (stage !== "hello") return;
            stage = "handshake";
            if (!online) {
              ws.send(JSON.stringify({ type: "error", code: "hostOffline" }));
              ws.close();
              return;
            }
            ws.send(JSON.stringify({ type: "tunnelConnected", streamId: randomUUID() }));
            return;
          }
          const plaintext = await hostRecv.decrypt(new Uint8Array(data as Buffer));
          if (stage === "handshake") {
            // 模拟宿主：校验客户端 e2e-hello 后回自己的 e2e-hello，并紧跟 bootstrap 帧。
            JSON.parse(new TextDecoder().decode(plaintext));
            stage = "open";
            ws.send(
              Buffer.from(
                await hostSend.encrypt(
                  new TextEncoder().encode(
                    JSON.stringify(
                      e2eHelloFrameSchema.parse({
                        type: "e2e-hello",
                        protocolVersion: TUNNEL_PROTOCOL_VERSION,
                      }),
                    ),
                  ),
                ),
              ),
              { binary: true },
            );
            ws.send(
              Buffer.from(
                await hostSend.encrypt(
                  new TextEncoder().encode(
                    JSON.stringify({
                      type: "tunnelBootstrap",
                      workspaces: [{ path: "/Users/demo/project", workspaceIdentity: "ident-1" }],
                    }),
                  ),
                ),
              ),
              { binary: true },
            );
            return;
          }
          // open：业务帧回声（模拟宿主 v4 通道应答）。
          ws.send(Buffer.from(await hostSend.encrypt(plaintext)), { binary: true });
        })().catch(() => ws.close());
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    setOnline: (value: boolean) => {
      online = value;
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const relay = await createFakeRelay();

after(async () => {
  await relay.close();
});

test("relayHttpOrigin 正确转换 ws/wss 源", () => {
  assert.equal(relayHttpOrigin("ws://x.example:8080"), "http://x.example:8080");
  assert.equal(relayHttpOrigin("wss://x.example"), "https://x.example");
  assert.equal(relayHttpOrigin("http://x.example"), "http://x.example");
});

test("宿主离线：客户端收到明确的 hostOffline 错误", async () => {
  relay.setOnline(false);
  try {
    await assert.rejects(
      () =>
        connectTunnelTransport({
          relayUrl: relay.wsUrl,
          hostId: HOST_ID,
          psk: PSK,
          sessionCredential: VALID_CREDENTIAL,
          WebSocketImpl: DomLikeWebSocketFactory as unknown as typeof WebSocket,
        }),
      (error: unknown) =>
        error instanceof TunnelConnectError && /宿主机当前不在线/.test(error.message),
    );
  } finally {
    relay.setOnline(true);
  }
});

test("全链路：凭证换票据 → 隧道握手 → bootstrap → 业务帧加解密回声", async () => {
  const { socket, bootstrap, close } = await connectTunnelTransport({
    relayUrl: relay.wsUrl,
    hostId: HOST_ID,
    psk: PSK,
    sessionCredential: VALID_CREDENTIAL,
    WebSocketImpl: DomLikeWebSocketFactory as unknown as typeof WebSocket,
  });

  const payload = `v4-frame-${randomUUID()}`;
  const echoed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no echo")), 3_000);
    const subscription = socket.onData((data) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(new TextDecoder().decode((data as VSBuffer).buffer));
    });
    socket.write(VSBuffer.wrap(new TextEncoder().encode(payload)));
  });
  assert.equal(echoed, payload, "业务帧必须经加密通道原样往返");
  assert.deepEqual(
    bootstrap,
    { workspaces: [{ path: "/Users/demo/project", workspaceIdentity: "ident-1" }] },
    "bootstrap 帧必须解析为 workspace 摘要",
  );

  // 坏 PSK 的客户端无法解密宿主 e2e-hello → 按配对信息不匹配报错。
  await assert.rejects(
    () =>
      connectTunnelTransport({
        relayUrl: relay.wsUrl,
        hostId: HOST_ID,
        psk: generateTunnelSecret(),
        sessionCredential: VALID_CREDENTIAL,
        WebSocketImpl: DomLikeWebSocketFactory as unknown as typeof WebSocket,
      }),
    (error: unknown) => error instanceof TunnelConnectError && /配对信息不匹配/.test(error.message),
  );

  // 凭证失效：票据阶段即 401。
  await assert.rejects(
    () =>
      connectTunnelTransport({
        relayUrl: relay.wsUrl,
        hostId: HOST_ID,
        psk: PSK,
        sessionCredential: "bad-credential",
        WebSocketImpl: DomLikeWebSocketFactory as unknown as typeof WebSocket,
      }),
    (error: unknown) => error instanceof TunnelConnectError && /会话已失效/.test(error.message),
  );

  close();
});
