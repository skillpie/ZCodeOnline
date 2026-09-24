import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import {
  TUNNEL_PROTOCOL_VERSION,
  TunnelCipher,
  deriveTunnelKeys,
  generateTunnelSecret,
  hashTunnelSecret,
} from "@zcode/shared";
import { startRelayServer, type RelayServer } from "../src/index.js";

// 隧道全链路集成验收（specs/web-tunnel.md §7 M1 场景 1/3/4/5）：
// 配对 → 连接票据 → 拼接管道 → 端到端密文互通 → 宿主离线可见 → 吊销与重放拒绝。

const BASE = "http://127.0.0.1";
const verifyAccount = (token: string | undefined) =>
  token === "acct-1" ? Promise.resolve({ userId: "user-1" }) : Promise.resolve(null);

let relay: RelayServer;
let wsBase: string;

async function nextMessage(
  ws: WebSocket,
  timeoutMs = 3_000,
): Promise<{ raw: string; binary: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    const onMessage = (data: unknown, isBinary: boolean): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve({
        raw: isBinary ? "" : String(data),
        binary: isBinary ? (data as Buffer) : null,
      });
    };
    ws.on("message", onMessage);
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}

/** 按协议顺序接入假宿主：hostHello → hostReady → pairingTokenRegister。 */
async function connectFakeHost(
  hostId: string,
  pairingToken: string,
  pskRef: { credential: string },
) {
  const sock = new WebSocket(`${wsBase}/ws/host`);
  await waitOpen(sock);
  sock.send(
    JSON.stringify({
      type: "hostHello",
      hostId,
      hostCredential: pskRef.credential,
      displayName: "dev-box",
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
    }),
  );
  const ready = JSON.parse((await nextMessage(sock)).raw) as { issuedHostCredential: string };
  if (ready.issuedHostCredential) pskRef.credential = ready.issuedHostCredential;
  sock.send(
    JSON.stringify({
      type: "pairingTokenRegister",
      pairingTokenHash: await hashTunnelSecret(pairingToken),
      expiresAt: Date.now() + 60_000,
    }),
  );
  return sock;
}

async function connectBrowser(hostId: string, connectToken: string) {
  const sock = new WebSocket(`${wsBase}/ws/tunnel/${hostId}`);
  await waitOpen(sock);
  sock.send(
    JSON.stringify({
      type: "tunnelClientHello",
      hostId,
      connectToken,
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
    }),
  );
  return sock;
}

async function postJson(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}:${relay.port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

let psk: string;

before(async () => {
  relay = await startRelayServer({ port: 0, verifyAccountToken: verifyAccount });
  wsBase = `ws://127.0.0.1:${relay.port}`;
  psk = generateTunnelSecret();
});

after(async () => {
  await relay.close();
});

test("配对成功：一次性 token 换会话凭证，重放被拒", async () => {
  const pairingToken = generateTunnelSecret();
  const credentialRef = { credential: "" };
  const hostSock = await connectFakeHost("h-pair", pairingToken, credentialRef);

  const first = await postJson("/api/v1/pair", { hostId: "h-pair", pairingToken }, "acct-1");
  assert.equal(first.status, 200);
  assert.equal(first.json.hostDisplayName, "dev-box");
  assert.ok(first.json.sessionCredential.length >= 32);

  const replay = await postJson("/api/v1/pair", { hostId: "h-pair", pairingToken }, "acct-1");
  assert.equal(replay.status, 401, "配对 token 重放必须失败");
  const anonymous = await postJson("/api/v1/pair", {
    hostId: "h-pair",
    pairingToken: generateTunnelSecret(),
  });
  assert.equal(anonymous.status, 401);
  hostSock.close();
});

test("全链路：票据 → 拼接 → 端到端密文互通", async () => {
  const pairingToken = generateTunnelSecret();
  const credentialRef = { credential: "" };
  const hostControl = await connectFakeHost("h-e2e", pairingToken, credentialRef);

  const pair = await postJson("/api/v1/pair", { hostId: "h-e2e", pairingToken }, "acct-1");
  assert.equal(pair.status, 200);
  const sessionCredential: string = pair.json.sessionCredential;

  const tokenResponse = await postJson("/api/v1/tunnel/connect-token", { sessionCredential });
  assert.equal(tokenResponse.status, 200);
  const connectToken: string = tokenResponse.json.connectToken;

  const streamOpenPromise = nextMessage(hostControl);
  const browser = await connectBrowser("h-e2e", connectToken);
  const streamOpen = JSON.parse((await streamOpenPromise).raw) as {
    type: string;
    streamId: string;
  };
  assert.equal(streamOpen.type, "streamOpen");

  const hostStream = new WebSocket(`${wsBase}/ws/host/stream/${streamOpen.streamId}`);
  await waitOpen(hostStream);
  const connected = JSON.parse((await nextMessage(browser)).raw);
  assert.equal(connected.type, "tunnelConnected");

  // 端到端加密：密文经 relay 拼接，两端各自解密校验。
  const keys = await deriveTunnelKeys(psk, "h-e2e");
  const browserSend = new TunnelCipher(keys.clientToHost, "clientToHost");
  const hostRecv = new TunnelCipher(keys.clientToHost, "clientToHost");
  const hostSend = new TunnelCipher(keys.hostToClient, "hostToClient");
  const browserRecv = new TunnelCipher(keys.hostToClient, "hostToClient");

  const payload = Buffer.from("会话快照增量 ".repeat(4096)); // ~100KB 大帧完整性
  const encrypted = await browserSend.encrypt(new Uint8Array(payload));
  const hostIncoming = nextMessage(hostStream, 5_000);
  browser.send(Buffer.from(encrypted), { binary: true });
  const received = await hostIncoming;
  assert.ok(received.binary, "宿主侧应收到二进制密文");
  assert.deepEqual(
    await hostRecv.decrypt(new Uint8Array(received.binary!)),
    new Uint8Array(payload),
  );

  const replyFrame = await hostSend.encrypt(new TextEncoder().encode("host ack"));
  const browserIncoming = nextMessage(browser, 5_000);
  hostStream.send(Buffer.from(await Promise.resolve(replyFrame)), { binary: true });
  const browserGot = await browserIncoming;
  assert.deepEqual(
    await browserRecv.decrypt(new Uint8Array(browserGot.binary!)),
    new TextEncoder().encode("host ack"),
  );

  browser.close();
  hostStream.close();
  hostControl.close();
});

test("宿主离线：浏览器拿到明确 hostOffline 错误", async () => {
  const wrongButWellFormed = generateTunnelSecret();
  const session = await postJson("/api/v1/tunnel/connect-token", {
    sessionCredential: wrongButWellFormed,
  });
  assert.equal(session.status, 401, "坏凭证换不到票据");

  const pairingToken = generateTunnelSecret();
  const credentialRef = { credential: "" };
  const hostControl = await connectFakeHost("h-off", pairingToken, credentialRef);
  const pair = await postJson("/api/v1/pair", { hostId: "h-off", pairingToken }, "acct-1");
  const connectToken = (
    await postJson("/api/v1/tunnel/connect-token", {
      sessionCredential: pair.json.sessionCredential,
    })
  ).json.connectToken;
  hostControl.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const browser = await connectBrowser("h-off", connectToken);
  const errorFrame = JSON.parse((await nextMessage(browser)).raw);
  assert.equal(errorFrame.type, "error");
  assert.equal(errorFrame.code, "hostOffline");
  browser.close();
});

test("吊销设备：凭证即刻失效", async () => {
  const pairingToken = generateTunnelSecret();
  const credentialRef = { credential: "" };
  const hostControl = await connectFakeHost("h-revoke", pairingToken, credentialRef);
  const pair = await postJson("/api/v1/pair", { hostId: "h-revoke", pairingToken }, "acct-1");
  const sessionCredential: string = pair.json.sessionCredential;

  const remove = await fetch(`${BASE}:${relay.port}/api/v1/tunnel/devices/h-revoke`, {
    method: "DELETE",
    headers: { authorization: "Bearer acct-1" },
  });
  assert.equal(remove.status, 200);

  const after = await postJson("/api/v1/tunnel/connect-token", { sessionCredential });
  assert.equal(after.status, 401, "吊销后旧凭证必须失效");
  hostControl.close();
});
