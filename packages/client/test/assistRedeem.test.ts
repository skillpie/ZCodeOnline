import assert from "node:assert/strict";
import { test } from "vitest";
import { generateTunnelSecret, maskAssistPsk, revealAssistPsk } from "@zcode/shared";
import {
  assertRedeemResult,
  AssistRedeemError,
  redeemAssistCodeViaEndpoint,
  redeemAssistCodeViaEndpointAsResult,
} from "../src/tunnel/assistRedeem.js";

// 远程码兑换验收（specs/web-tunnel.md §5.9「码即凭证」）：HTTP 错误归类
// （invalid 驱动调用方清存储回退）、成功兑换的 PSK 还原，以及桌面 main 代理
// 结构化应答 → 同一套错误语义的映射。端点由调用方注入（Web 同源相对路径）。

const ENDPOINT = "/relay/api/v1/assist/connect";

test("401 → invalid（码被轮换，调用方据此清存储回退）", async () => {
  await assert.rejects(
    () =>
      redeemAssistCodeViaEndpoint(
        "12345678",
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
        "12345678",
        ENDPOINT,
        async () => new Response(null, { status: 429 }),
      ),
    (cause: unknown) => cause instanceof AssistRedeemError && cause.kind === "rateLimited",
  );
  await assert.rejects(
    () =>
      redeemAssistCodeViaEndpoint("12345678", ENDPOINT, async () => {
        throw new Error("offline");
      }),
    (cause: unknown) => cause instanceof AssistRedeemError && cause.kind === "network",
  );
});

test("成功兑换：maskedPsk 经码还原出原 psk", async () => {
  const psk = generateTunnelSecret();
  const code = "12345678";
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

test("结构化兑换（Web 平台契约用）：成功透传；错误归类为 kind + 面向用户文案", async () => {
  const psk = generateTunnelSecret();
  const code = "12345678";
  const maskedPsk = await maskAssistPsk(psk, code);
  const ok = await redeemAssistCodeViaEndpointAsResult(code, ENDPOINT, async () =>
    new Response(
      JSON.stringify({
        hostId: "h-1",
        connectToken: `tok-${"x".repeat(40)}`,
        maskedPsk,
        hostDisplayName: "技术中心的Mac",
      }),
      { status: 200 },
    ),
  );
  assert.equal(ok.ok, true);
  assert.equal(await revealAssistPsk(maskedPsk, code), (ok as { psk: string }).psk);
  // 宿主展示名透传（弹窗添加远程链接的条目默认名）。
  assert.equal((ok as { hostDisplayName?: string }).hostDisplayName, "技术中心的Mac");
  // 旧 relay 不带该字段 → 缺省，不报错。
  const legacy = await redeemAssistCodeViaEndpointAsResult(code, ENDPOINT, async () =>
    new Response(
      JSON.stringify({ hostId: "h-1", connectToken: `tok-${"x".repeat(40)}`, maskedPsk }),
      { status: 200 },
    ),
  );
  assert.equal(legacy.ok, true);
  assert.equal((legacy as { hostDisplayName?: string }).hostDisplayName, undefined);

  // 401 → invalid：弹窗「添加远程链接」预检据此拒绝入库并展示原因。
  const invalid = await redeemAssistCodeViaEndpointAsResult(code, ENDPOINT, async () =>
    new Response(null, { status: 401 }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok ? null : invalid.kind, "invalid");
  assert.ok(invalid.ok ? false : invalid.message.length > 0);

  // 底层 fetch 抛错已归类为 network（非 AssistRedeemError 的异常兜底为 generic，
  // 正常路径不可达）；封装层保证任何情况下都不向调用方抛异常。
  const degraded = await redeemAssistCodeViaEndpointAsResult(code, ENDPOINT, async () => {
    throw new Error("offline");
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.ok ? null : degraded.kind, "network");
});
