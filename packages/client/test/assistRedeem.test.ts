import assert from "node:assert/strict";
import { test } from "node:test";
import { generateTunnelSecret, maskAssistPsk, revealAssistPsk } from "@zcode/shared";
import {
  assertRedeemResult,
  AssistRedeemError,
  redeemAssistCodeViaEndpoint,
} from "../src/tunnel/assistRedeem.js";

// 远程码兑换验收（specs/web-tunnel.md §5.9「码即凭证」）：HTTP 错误归类
// （invalid 驱动调用方清存储回退）、成功兑换的 PSK 还原，以及桌面 main 代理
// 结构化应答 → 同一套错误语义的映射。端点由调用方注入（Web 同源相对路径）。

const ENDPOINT = "/relay/api/v1/assist/connect";

test("401 → invalid（码被轮换，调用方据此清存储回退）", async () => {
  await assert.rejects(
    () =>
      redeemAssistCodeViaEndpoint(
        "1234567890123456",
        ENDPOINT,
        async () => new Response(null, { status: 401 }),
      ),
    (cause: unknown) => cause instanceof AssistRedeemError && cause.kind === "invalid",
  );
});

test("429 → rateLimited；网络异常 → network", async () => {
  await assert.rejects(
    () =>
      redeemAssistCodeViaEndpoint(
        "1234567890123456",
        ENDPOINT,
        async () => new Response(null, { status: 429 }),
      ),
    (cause: unknown) => cause instanceof AssistRedeemError && cause.kind === "rateLimited",
  );
  await assert.rejects(
    () =>
      redeemAssistCodeViaEndpoint("1234567890123456", ENDPOINT, async () => {
        throw new Error("offline");
      }),
    (cause: unknown) => cause instanceof AssistRedeemError && cause.kind === "network",
  );
});

test("成功兑换：maskedPsk 经码还原出原 psk", async () => {
  const psk = generateTunnelSecret();
  const code = "1234567890123456";
  const maskedPsk = await maskAssistPsk(psk, code);
  const redeemed = await redeemAssistCodeViaEndpoint(
    code,
    ENDPOINT,
    async () =>
      new Response(
        JSON.stringify({ hostId: "h-1", connectToken: `tok-${"x".repeat(40)}`, maskedPsk }),
        { status: 200 },
      ),
  );
  assert.equal(redeemed.hostId, "h-1");
  assert.equal(await revealAssistPsk(maskedPsk, code), redeemed.psk);
});

test("assertRedeemResult：成功应答透传；失败应答还原为 AssistRedeemError", () => {
  const ok = assertRedeemResult({
    ok: true,
    hostId: "h-1",
    connectToken: `tok-${"x".repeat(40)}`,
    psk: "psk-value",
  });
  assert.deepEqual(ok, { hostId: "h-1", connectToken: `tok-${"x".repeat(40)}`, psk: "psk-value" });
  for (const kind of ["invalid", "rateLimited", "network", "generic"] as const) {
    try {
      assertRedeemResult({ ok: false, kind, message: "boom" });
      assert.fail(`kind=${kind} 应抛错`);
    } catch (cause) {
      assert.ok(cause instanceof AssistRedeemError);
      assert.equal(cause.kind, kind);
    }
  }
});
