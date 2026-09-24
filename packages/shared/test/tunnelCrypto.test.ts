import assert from "node:assert/strict";
import { test } from "node:test";
import { TunnelCipher, deriveTunnelKeys } from "../src/tunnelCrypto.js";
import { generateTunnelSecret } from "../src/tunnel.js";

// 隧道端到端加密验收（specs/web-tunnel.md §3.4）：
// 双向派生独立、加解密闭环、密钥不符/重放/乱序/篡改拒绝。

test("双向密钥独立派生，加解密闭环", async () => {
  const psk = generateTunnelSecret();
  const keys = await deriveTunnelKeys(psk, "host-a");
  // 同一条流两端共用同一密钥实例方向：发送侧 encrypt、接收侧 decrypt。
  const clientSend = new TunnelCipher(keys.clientToHost, "clientToHost");
  const hostRecv = new TunnelCipher(keys.clientToHost, "clientToHost");
  const hostSend = new TunnelCipher(keys.hostToClient, "hostToClient");
  const clientRecv = new TunnelCipher(keys.hostToClient, "hostToClient");

  const plaintext = new TextEncoder().encode("会话快照增量 payload");
  const frame = await clientSend.encrypt(plaintext);
  assert.deepEqual(await hostRecv.decrypt(frame), plaintext);
  const reply = await hostSend.encrypt(plaintext);
  assert.deepEqual(await clientRecv.decrypt(reply), plaintext);
});

test("不同 hostId / PSK 派生出的密钥无法互解", async () => {
  const psk = generateTunnelSecret();
  const keysA = await deriveTunnelKeys(psk, "host-a");
  const keysB = await deriveTunnelKeys(psk, "host-b");
  const frame = await new TunnelCipher(keysA.clientToHost, "clientToHost").encrypt(
    new TextEncoder().encode("secret"),
  );
  await assert.rejects(() => new TunnelCipher(keysB.clientToHost, "clientToHost").decrypt(frame));
  const keysOtherPsk = await deriveTunnelKeys(generateTunnelSecret(), "host-a");
  await assert.rejects(() =>
    new TunnelCipher(keysOtherPsk.clientToHost, "clientToHost").decrypt(frame),
  );
});

test("重放与乱序帧被序号严格递增拒绝", async () => {
  const keys = await deriveTunnelKeys(generateTunnelSecret(), "host-a");
  const client = new TunnelCipher(keys.clientToHost, "clientToHost");
  const host = new TunnelCipher(keys.clientToHost, "clientToHost");
  const encode = (value: string) => new TextEncoder().encode(value);

  const first = await client.encrypt(encode("1"));
  const second = await client.encrypt(encode("2"));
  const third = await client.encrypt(encode("3"));
  assert.deepEqual(await host.decrypt(first), encode("1"));
  await assert.rejects(() => host.decrypt(first), /regression/);
  // 跳号允许（WS 保序下跳号只意味上游丢帧，不构成重放），但回落序号一律拒绝。
  assert.deepEqual(await host.decrypt(third), encode("3"));
  await assert.rejects(() => host.decrypt(second), /regression/);
});

test("密文被篡改时 GCM 校验失败", async () => {
  const keys = await deriveTunnelKeys(generateTunnelSecret(), "host-a");
  const client = new TunnelCipher(keys.clientToHost, "clientToHost");
  const host = new TunnelCipher(keys.clientToHost, "clientToHost");
  const frame = await client.encrypt(new TextEncoder().encode("payload"));
  frame[frame.length - 1]! ^= 0xff;
  await assert.rejects(() => host.decrypt(frame));
});

test("超限帧在加密侧即拒绝", async () => {
  const keys = await deriveTunnelKeys(generateTunnelSecret(), "host-a");
  const client = new TunnelCipher(keys.clientToHost, "clientToHost");
  await assert.rejects(() => client.encrypt(new Uint8Array(1024 * 1024 + 1)), /exceeds/);
});
