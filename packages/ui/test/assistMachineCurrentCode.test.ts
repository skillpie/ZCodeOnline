import assert from "node:assert/strict";
import test from "node:test";
import { resolveCurrentAssistCode } from "../src/assistMachineCurrentCode.js";

test("活动码优先：Web 与桌面隧道模式都以存储的活动码为当前", () => {
  assert.equal(resolveCurrentAssistCode("12345678", "87654321", false), "12345678");
  assert.equal(resolveCurrentAssistCode("12345678", "87654321", true), "12345678");
});

test("桌面本地模式（无活动码）本机即当前", () => {
  assert.equal(resolveCurrentAssistCode(null, "87654321", true), "87654321");
});

test("Web 无活动码时无当前条目（卡片全部可点）", () => {
  assert.equal(resolveCurrentAssistCode(null, "87654321", false), null);
});

test("桌面本地模式但本机码未发现时无当前条目", () => {
  assert.equal(resolveCurrentAssistCode(null, null, true), null);
});
