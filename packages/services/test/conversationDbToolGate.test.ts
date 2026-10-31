// 会话级数据源门控纯函数的行为测试（specs/data-source.md §7）。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CONVERSATION_DB_TOOL_NAMES,
  mergeFirstInputDbToolGate,
  mergeSendTextDbToolGate,
  resolveSendTextDataSourceGate,
} from "../src/zcode-agent/conversationDbToolGate.js";

test("sendText 未绑定数据源时注入 DB 工具名单", () => {
  const merged = mergeSendTextDbToolGate(undefined, undefined);
  assert.deepEqual([...(merged ?? [])], [...CONVERSATION_DB_TOOL_NAMES]);
});

test("sendText 已绑定数据源时原名单透传（同一引用，信封不改写）", () => {
  const existing = ["CronCreate"];
  assert.equal(mergeSendTextDbToolGate(existing, "ds-1"), existing);
  assert.equal(mergeSendTextDbToolGate(undefined, "ds-1"), undefined);
});

test("sendText 未绑定时保留调用方既有名单且不覆盖", () => {
  const merged = mergeSendTextDbToolGate(["CronCreate"], undefined);
  assert.ok(merged);
  assert.equal(merged[0], "CronCreate");
  assert.deepEqual(merged.slice(-CONVERSATION_DB_TOOL_NAMES.length), [
    ...CONVERSATION_DB_TOOL_NAMES,
  ]);
});

test("firstInput 未绑定数据源且未自带名单时注入", () => {
  const merged = mergeFirstInputDbToolGate({ text: "hi" });
  assert.deepEqual(merged.toolDisallowlist, [...CONVERSATION_DB_TOOL_NAMES]);
  assert.equal(merged.text, "hi");
});

test("firstInput 已绑定数据源时原样返回（同一引用）", () => {
  const firstInput = { text: "hi", dataSourceId: "ds-1" };
  assert.equal(mergeFirstInputDbToolGate(firstInput), firstInput);
});

test("firstInput 调用方自带名单时不覆盖", () => {
  const firstInput = { text: "hi", toolDisallowlist: ["Bash"] };
  assert.equal(mergeFirstInputDbToolGate(firstInput), firstInput);
});

test("sendText 权威解析：payload 携带时优先且不改名单（宿主绑定被忽略）", () => {
  const decision = resolveSendTextDataSourceGate(
    { dataSourceId: "ds-payload", toolDisallowlist: ["CronCreate"] },
    "ds-binding",
  );
  assert.equal(decision.effectiveDataSourceId, "ds-payload");
  assert.equal(decision.toolDisallowlist, undefined);
});

test("sendText 权威解析：payload 缺失时回退宿主会话绑定", () => {
  const decision = resolveSendTextDataSourceGate(
    { toolDisallowlist: ["CronCreate"] },
    "ds-binding",
  );
  assert.equal(decision.effectiveDataSourceId, "ds-binding");
  // 已绑定 → 名单透传（无需改写，payload 原名单保持不动），不注入 DB 名单
  assert.equal(decision.toolDisallowlist, undefined);
});

test("sendText 权威解析：payload 与绑定都为空时注入 DB 名单", () => {
  const decision = resolveSendTextDataSourceGate({}, null);
  assert.equal(decision.effectiveDataSourceId, undefined);
  assert.deepEqual([...(decision.toolDisallowlist ?? [])], [...CONVERSATION_DB_TOOL_NAMES]);
});

test("sendText 权威解析：绑定回退且无既有名单时仅回填、不产生名单", () => {
  const decision = resolveSendTextDataSourceGate({}, "ds-binding");
  assert.equal(decision.effectiveDataSourceId, "ds-binding");
  assert.equal(decision.toolDisallowlist, undefined);
});
