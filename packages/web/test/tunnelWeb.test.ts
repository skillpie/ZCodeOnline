import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPairingUrl, generateTunnelSecret, parsePairingUrl } from "@zcode/shared";
import { TunnelPairingError, pairWithCode } from "../src/tunnel/tunnelSession.js";

// Web 隧道配对链路验收（specs/web-tunnel.md §3.3）：配对码解析失败/过期/有效载荷。
// 传输层（tunnelSocket）测试随实现迁至 packages/client/test/tunnelTransport.test.ts。

const HOST_ID = "h-web";
const RELAY_WS_URL = "ws://relay.example";

test("配对码：解析失败/过期均有可读错误；有效载荷可往返解析", async () => {
  await assert.rejects(
    () => pairWithCode({ pairingUrl: "not-a-pair-url", accessToken: null }),
    TunnelPairingError,
  );
  const expired = buildPairingUrl({
    relayUrl: RELAY_WS_URL,
    hostId: HOST_ID,
    pairingToken: generateTunnelSecret(),
    psk: generateTunnelSecret(),
    expiresAt: Date.now() - 1,
    displayName: "dev",
  });
  await assert.rejects(() => pairWithCode({ pairingUrl: expired, accessToken: null }), /过期/);
  const payload = parsePairingUrl(
    buildPairingUrl({
      relayUrl: RELAY_WS_URL,
      hostId: HOST_ID,
      pairingToken: generateTunnelSecret(),
      psk: generateTunnelSecret(),
      expiresAt: Date.now() + 60_000,
      displayName: "dev-box",
    }),
  );
  assert.ok(payload);
  assert.equal(payload.hostId, HOST_ID);
});
