import assert from "node:assert/strict";
import { test } from "node:test";
import { controlRequestSchema, coreCommandSchema } from "../src/contracts.js";

// 控制链契约验收：桌面远程控制新增的 tunnel-assist-code / tunnel-assist-refresh
// 命令要能通过 Supervisor 的控制请求校验，并以 assist-* action 转发给 Core
// （Core 侧 tunnel.handle 原生支持该 action，结果经 tunnel-control-result 关联回）。

test("tunnel-assist-code/refresh 通过控制请求 union 校验", () => {
  assert.equal(
    controlRequestSchema.safeParse({ id: "req-1", command: "tunnel-assist-code" }).success,
    true,
  );
  assert.equal(
    controlRequestSchema.safeParse({ id: "req-2", command: "tunnel-assist-refresh" }).success,
    true,
  );
  assert.equal(
    controlRequestSchema.safeParse({ id: "req-3", command: "tunnel-assist-unknown" }).success,
    false,
  );
});

test("tunnel-control 的 action 支持 assist-code/assist-refresh", () => {
  for (const action of ["assist-code", "assist-refresh"] as const) {
    const parsed = coreCommandSchema.parse({
      command: "tunnel-control",
      requestId: "req-1",
      action,
    });
    assert.equal(parsed.command, "tunnel-control");
  }
  assert.equal(
    coreCommandSchema.safeParse({
      command: "tunnel-control",
      requestId: "req-1",
      action: "assist-unknown",
    }).success,
    false,
  );
});
