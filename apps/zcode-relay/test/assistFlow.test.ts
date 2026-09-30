import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import {
  TUNNEL_ASSIST_TTL_MS,
  TUNNEL_PROTOCOL_VERSION,
  formatAssistCode,
  generateAssistCode,
  generateTunnelSecret,
  hashTunnelSecret,
  maskAssistPsk,
  normalizeAssistCode,
  revealAssistPsk,
} from "@zcode/shared";
import { startRelayServer, type RelayServer } from "../src/index.js";

// 远程协助验收（specs/web-tunnel.md §5.9）：
// 登记 → 兑换（一次性）→ 掩码可还原 → 单码单用户 → 限流 → 非法码。

const BASE = "http://127.0.0.1";
const verifyAccount = (token: string | undefined) =>
  token === "acct-1" ? Promise.resolve({ userId: "user-1" }) : Promise.resolve(null);

let relay: RelayServer;

async function nextMessage(ws: WebSocket, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
}

before(async () => {
  relay = await startRelayServer({ port: 0, verifyAccountToken: verifyAccount });
});

after(async () => {
  await relay.close();
});

async function registerAssistHost(hostId: string, code: string) {
  const psk = generateTunnelSecret();
  const maskedPsk = await maskAssistPsk(psk, code);
  const ws = new WebSocket(`${BASE}:${relay.port}/ws/host`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      type: "hostHello",
      hostId,
      hostCredential: "",
      displayName: "assist-host",
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
    }),
  );
  await nextMessage(ws); // hostReady
  ws.send(
    JSON.stringify({
      type: "assistRegister",
      assistCodeHash: await hashTunnelSecret(code),
      maskedPsk,
      expiresAt: Date.now() + TUNNEL_ASSIST_TTL_MS,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ws, psk, maskedPsk };
}

async function redeem(code: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}:${relay.port}/api/v1/assist/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return { status: response.status, json: await response.json() };
}

test("远程码归一化与展示格式", () => {
  assert.equal(normalizeAssistCode("1234 5678"), "12345678");
  assert.equal(normalizeAssistCode("12-34-56-78"), "12345678");
  assert.equal(normalizeAssistCode("123"), null);
  assert.equal(normalizeAssistCode("123456789"), null);
  assert.equal(normalizeAssistCode("1234567890123456"), null, "旧版 16 位码不再接受");
  assert.equal(formatAssistCode("12345678"), "1234 5678");
  assert.ok(generateAssistCode().match(/^\d{8}$/u));
});

test("掩码零知识：relay 视角的 maskedPsk 可被持码方还原", async () => {
  const code = generateAssistCode();
  const psk = generateTunnelSecret();
  const masked = await maskAssistPsk(psk, code);
  assert.notEqual(masked, psk);
  assert.equal(await revealAssistPsk(masked, code), psk);
});

test("兑换成功且持久：同一码可反复兑换（多浏览器），PSK 可还原", async () => {
  const code = generateAssistCode();
  const { ws, psk, maskedPsk } = await registerAssistHost("h-assist-1", code);

  const first = await redeem(code);
  assert.equal(first.status, 200);
  assert.equal(first.json.hostId, "h-assist-1");
  assert.equal(await revealAssistPsk(first.json.maskedPsk, code), psk);
  assert.ok(first.json.connectToken.length >= 32);

  // 持久机器码：不消费，任意浏览器可反复兑换（每次 connectToken 独立）
  const second = await redeem(code);
  assert.equal(second.status, 200);
  assert.equal(await revealAssistPsk(second.json.maskedPsk, code), psk);
  ws.close();
});

test("非法码/格式错误码被拒", async () => {
  assert.equal((await redeem(generateTunnelSecret())).status, 401);
  assert.equal((await redeem("123")).status, 400);
});

test("刷新作废旧码：同控制通道重登记（对齐连接器行为），旧码兑换失败，新码可用", async () => {
  const code = generateAssistCode();
  const { ws, psk, maskedPsk } = await registerAssistHost("h-assist-2", code);

  // 「刷新」= 同一条控制通道上重新登记（连接器 regenerateAssistCode 的行为）；
  // 同 hostId 的第二次空凭证连接会被防抢注拒绝（见 connectFlow），因此不走新连接。
  const newCode = generateAssistCode();
  const newPsk = generateTunnelSecret();
  const newMasked = await maskAssistPsk(newPsk, newCode);
  assert.notEqual(newMasked, maskedPsk);
  ws.send(
    JSON.stringify({
      type: "assistRegister",
      assistCodeHash: await hashTunnelSecret(newCode),
      maskedPsk: newMasked,
      expiresAt: Date.now() + TUNNEL_ASSIST_TTL_MS,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal((await redeem(code)).status, 401, "旧码已被刷新作废");
  const redeemed = await redeem(newCode);
  assert.equal(redeemed.status, 200);
  assert.equal(await revealAssistPsk(redeemed.json.maskedPsk, newCode), newPsk);
  ws.close();
});
