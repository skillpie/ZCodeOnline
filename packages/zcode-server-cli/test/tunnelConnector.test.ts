import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { WebSocket, WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  TUNNEL_PROTOCOL_VERSION,
  TunnelCipher,
  deriveTunnelKeys,
  e2eHelloFrameSchema,
  generateTunnelSecret,
  hashTunnelSecret,
  parsePairingUrl,
} from "@zcode/shared";
import { TunnelConnector, type TunnelConnectorEvent } from "../src/tunnel/tunnelConnector.js";
import { startPairingSession } from "../src/tunnel/tunnelPairing.js";

// 隧道连接器集成验收（specs/web-tunnel.md §3.2 / §7）：
// 出站握手与凭证签发、配对 token 登记、E2E 拼接流桥接回声、控制通道断线重连。

const HOST_ID = "zc-test-host";

interface FakeRelay {
  url: string;
  close(): Promise<void>;
  /** 模拟 relay 的浏览器侧：连拼接流路径，upgrade 时向宿主控制通道发 streamOpen。 */
  openStream(): Promise<WsSocket>;
  pairingTokenHashes(): string[];
  closeHostControl(): void;
}

async function createFakeRelay(): Promise<FakeRelay> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const browserSides = new Map<string, WsSocket>();
  const tokens: string[] = [];
  let hostControl: WsSocket | null = null;
  const issuedCredential = `cred-${randomUUID()}`;

  const pipe = (from: WsSocket, to: WsSocket): void => {
    from.on("message", (data, isBinary) => {
      if (isBinary && to.readyState === WebSocket.OPEN) to.send(data, { binary: true });
    });
  };

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (pathname === "/ws/host") {
        hostControl = ws;
        ws.on("message", (data) => {
          const frame = JSON.parse(String(data)) as Record<string, unknown>;
          if (frame.type === "hostHello") {
            ws.send(
              JSON.stringify({
                type: "hostReady",
                issuedHostCredential: issuedCredential,
                serverTime: Date.now(),
              }),
            );
          }
          if (frame.type === "pairingTokenRegister") {
            tokens.push(String(frame.pairingTokenHash));
          }
        });
        return;
      }
      const match = /^\/ws\/host\/stream\/(.+)$/.exec(pathname);
      if (!match) {
        ws.close(1008, "not found");
        return;
      }
      const streamId = match[1]!;
      const browserSide = browserSides.get(streamId);
      if (!browserSide) {
        // 第一条连接 = 浏览器侧；登记并通知宿主开流（对齐真 relay 时序）。
        browserSides.set(streamId, ws);
        hostControl?.send(JSON.stringify({ type: "streamOpen", streamId }));
        return;
      }
      // 第二条连接 = 宿主流；拼接后逐帧透传（假 relay 不解密）。
      pipe(ws, browserSide);
      pipe(browserSide, ws);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    pairingTokenHashes: () => tokens,
    closeHostControl: () => hostControl?.close(),
    openStream() {
      const streamId = randomUUID();
      return new Promise((resolve, reject) => {
        const browserSide = new WebSocket(`${this.url}/ws/host/stream/${streamId}`);
        browserSide.once("open", () => resolve(browserSide));
        browserSide.once("error", reject);
      });
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createEchoBusinessServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) ws.send(data, { binary: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const relay = await createFakeRelay();
const business = await createEchoBusinessServer();
const psk = generateTunnelSecret();
const events: TunnelConnectorEvent[] = [];
const issuedCredentials: string[] = [];
const connector = new TunnelConnector({
  relayUrl: relay.url,
  hostId: HOST_ID,
  hostCredential: "",
  displayName: "test-box",
  psk,
  loopbackWsUrl: business.url,
  onCredentialIssued: (credential) => issuedCredentials.push(credential),
  onEvent: (event) => events.push(event),
});

function waitForEvent(kind: TunnelConnectorEvent["kind"], timeoutMs = 5_000): Promise<void> {
  const fromIndex = events.length;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (events.slice(fromIndex).some((event) => event.kind === kind)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `timeout waiting for event ${kind}; got: ${
              events
                .slice(fromIndex)
                .map((event) => event.kind)
                .join(",") || "none"
            }`,
          ),
        );
      }
    }, 10);
  });
}

before(async () => {
  connector.start();
  await waitForEvent("connected");
});

after(async () => {
  connector.stop();
  await relay.close();
  await business.close();
});

test("hostReady 签发宿主凭证并回传给持久化回调", () => {
  assert.equal(issuedCredentials.length, 1);
  assert.ok(issuedCredentials[0]!.startsWith("cred-"));
});

test("配对会话：二维码载荷可解析、token 哈希经控制通道登记", async () => {
  const session = await startPairingSession({
    connector,
    hostId: HOST_ID,
    displayName: "test-box",
  });
  try {
    assert.ok(session.url.startsWith("zcode-tunnel://pair?"));
    const payload = parsePairingUrl(session.url);
    assert.ok(payload);
    assert.equal(payload.hostId, HOST_ID);
    assert.equal(payload.psk, psk);
    assert.equal(payload.relayUrl, relay.url);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hashes = relay.pairingTokenHashes();
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0], await hashTunnelSecret(payload.pairingToken));
  } finally {
    session.dispose();
  }
});

test("拼接流：E2E 握手 + 业务帧经解密桥接到回声服务", async () => {
  const browserSide = await relay.openStream();

  const keys = await deriveTunnelKeys(psk, HOST_ID);
  const browserSend = new TunnelCipher(keys.clientToHost, "clientToHost");
  const browserRecv = new TunnelCipher(keys.hostToClient, "hostToClient");

  // 宿主先发 e2e-hello（首条二进制密文）。
  const firstFrame = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no e2e hello")), 3_000);
    browserSide.on("message", (data, isBinary) => {
      if (isBinary) {
        clearTimeout(timer);
        resolve(data as Buffer);
      }
    });
  });
  const decryptedHello = await browserRecv.decrypt(new Uint8Array(firstFrame));
  assert.equal(
    e2eHelloFrameSchema.safeParse(JSON.parse(Buffer.from(decryptedHello).toString())).success,
    true,
  );

  // 浏览器回 e2e-hello，随后业务帧应经连接器解密 → 回声服务 → 加密返回。
  await browserSend
    .encrypt(
      new TextEncoder().encode(
        JSON.stringify({ type: "e2e-hello", protocolVersion: TUNNEL_PROTOCOL_VERSION }),
      ),
    )
    .then((frame) => browserSide.send(Buffer.from(frame), { binary: true }));

  const businessPayload = Buffer.from(`v4-business-frame-${randomUUID()}`);
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no echo reply")), 3_000);
    const onMessage = (data: unknown, isBinary: boolean) => {
      if (!isBinary) return;
      clearTimeout(timer);
      browserSide.off("message", onMessage);
      resolve(data as Buffer);
    };
    browserSide.on("message", onMessage);
    void browserSend
      .encrypt(new Uint8Array(businessPayload))
      .then((frame) => browserSide.send(Buffer.from(frame), { binary: true }));
  });
  const decrypted = await browserRecv.decrypt(new Uint8Array(reply));
  assert.ok(Buffer.from(decrypted).equals(businessPayload), "回声内容必须与业务帧一致");
});

test("控制通道断线：沿用凭证自动重连", async () => {
  events.length = 0;
  relay.closeHostControl();
  await waitForEvent("reconnecting");
  await waitForEvent("connected");
});
