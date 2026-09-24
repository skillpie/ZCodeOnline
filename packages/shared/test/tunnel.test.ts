import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TUNNEL_CONSTANTS,
  TUNNEL_PROTOCOL_VERSION,
  buildPairingUrl,
  generateTunnelSecret,
  hashTunnelSecret,
  parsePairingUrl,
  pairingPayloadSchema,
  hostControlFrameSchema,
  relayHostFrameSchema,
  tunnelClientHelloSchema,
} from "../src/tunnel.js";

// Web 隧道契约验收（specs/web-tunnel.md §3.3 / §3.4）：
// 配对码编解码闭环、字段校验拒绝、控制帧 schema 收紧、secret 哈希稳定。

function validPayload() {
  return {
    relayUrl: "wss://relay.example.com",
    hostId: "host-1234",
    pairingToken: generateTunnelSecret(),
    psk: generateTunnelSecret(),
    expiresAt: Date.now() + TUNNEL_CONSTANTS.pairingTokenTtlMs,
    displayName: "Jensen 的台式机",
  };
}

test("pairing url 编码后可无损解析", () => {
  const payload = validPayload();
  const parsed = parsePairingUrl(buildPairingUrl(payload));
  assert.deepEqual(parsed, payload);
});

test("parsePairingUrl 拒绝协议版本不匹配与非法载荷", () => {
  const payload = validPayload();
  const url = buildPairingUrl(payload);
  assert.equal(parsePairingUrl("https://evil.example.com/pair"), null);
  assert.equal(parsePairingUrl(url.replace(`v=${TUNNEL_PROTOCOL_VERSION}`, "v=99")), null);
  assert.equal(parsePairingUrl(url.replace(/token=[^&]+/, "token=short")), null);
});

test("pairingPayloadSchema 收紧非法字段", () => {
  assert.equal(pairingPayloadSchema.safeParse(validPayload()).success, true);
  const bad = validPayload();
  bad.relayUrl = "not-a-url";
  assert.equal(pairingPayloadSchema.safeParse(bad).success, false);
});

test("控制帧 schema 拒绝未知字段与未知 type", () => {
  assert.equal(
    hostControlFrameSchema.safeParse({
      type: "hostHello",
      hostId: "h1",
      hostCredential: "c".repeat(40),
      displayName: "dev",
      protocolVersion: 1,
    }).success,
    true,
  );
  assert.equal(
    hostControlFrameSchema.safeParse({ type: "hostHello", hostId: "h1", extra: 1 }).success,
    false,
  );
  assert.equal(
    relayHostFrameSchema.safeParse({ type: "streamOpen", streamId: "s1" }).success,
    true,
  );
  assert.equal(relayHostFrameSchema.safeParse({ type: "mystery" }).success, false);
});

test("tunnelClientHello 校验一次性票据字段", () => {
  assert.equal(
    tunnelClientHelloSchema.safeParse({
      type: "tunnelClientHello",
      hostId: "h1",
      connectToken: generateTunnelSecret(),
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
    }).success,
    true,
  );
  assert.equal(
    tunnelClientHelloSchema.safeParse({ type: "tunnelClientHello", hostId: "h1" }).success,
    false,
  );
});

test("hashTunnelSecret 稳定且区分大小写敏感输入", async () => {
  const secret = generateTunnelSecret();
  const first = await hashTunnelSecret(secret);
  assert.equal(await hashTunnelSecret(secret), first);
  assert.notEqual(await hashTunnelSecret(secret + "x"), first);
  assert.equal(first.length, 43);
});
