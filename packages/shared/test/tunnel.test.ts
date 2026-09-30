import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TUNNEL_CONSTANTS,
  TUNNEL_PROTOCOL_VERSION,
  buildPairingUrl,
  generateTunnelSecret,
  hashTunnelSecret,
  parsePairingUrl,
  parseAssistCodeInput,
  pairingPayloadSchema,
  hostControlFrameSchema,
  relayHostFrameSchema,
  relayHttpOrigin,
  relayWebOrigin,
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

test("relayHttpOrigin/relayWebOrigin 转换 ws/wss 地址", () => {
  assert.equal(relayHttpOrigin("wss://x.example/relay"), "https://x.example/relay");
  assert.equal(relayHttpOrigin("ws://x.example:8080"), "http://x.example:8080");
  assert.equal(relayHttpOrigin("http://x.example"), "http://x.example");
  // Web 站点源（分享链接 <origin>/<码> 用）：去掉 /relay 路径前缀。
  assert.equal(relayWebOrigin("wss://zcode.skillpie.cn/relay"), "https://zcode.skillpie.cn");
  assert.equal(relayWebOrigin("ws://127.0.0.1:8080/relay/"), "http://127.0.0.1:8080");
  assert.equal(relayWebOrigin("wss://x.example"), "https://x.example");
});

test("parseAssistCodeInput 从远程链接或裸码提取 16 位码", () => {
  // 完整链接：产品部署、别名路径、带端口/查询参数。
  assert.equal(
    parseAssistCodeInput("https://zcode.skillpie.cn/1234567890123456"),
    "1234567890123456",
  );
  assert.equal(
    parseAssistCodeInput("https://zcode.skillpie.cn/remote/1234567890123456"),
    "1234567890123456",
  );
  assert.equal(
    parseAssistCodeInput("http://localhost:5173/1234567890123456?x=1"),
    "1234567890123456",
    "端口/查询里的数字不参与提取",
  );
  // 裸码与 4-4-4-4 分组形态。
  assert.equal(parseAssistCodeInput("1234567890123456"), "1234567890123456");
  assert.equal(parseAssistCodeInput("1234 5678 9012 3456"), "1234567890123456");
  // 无法提取：空输入、位数不足、链接无路径、非链接的杂乱文本。
  assert.equal(parseAssistCodeInput(""), null);
  assert.equal(parseAssistCodeInput("12345678"), null);
  assert.equal(parseAssistCodeInput("https://zcode.skillpie.cn/"), null);
  assert.equal(parseAssistCodeInput("not a code"), null);
});

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
