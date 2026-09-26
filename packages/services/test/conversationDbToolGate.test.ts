// 会话级数据源门控纯函数的行为测试（specs/data-source.md §7）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_DB_TOOL_NAMES,
  mergeFirstInputDbToolGate,
  mergeSendTextDbToolGate,
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
