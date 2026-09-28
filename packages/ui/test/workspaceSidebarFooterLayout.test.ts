import assert from "node:assert/strict";
import test from "node:test";
import { shouldRenderBotChannelTrigger } from "../src/workspaceSidebarFooterLayout.js";

test("web（无平台标志）有 workspacePath 时渲染 Bot Channel 入口", () => {
  assert.equal(shouldRenderBotChannelTrigger({ workspacePath: "/home/user/project" }), true);
});

test("workspacePath 缺失或空白时不渲染，Web 与桌面一致", () => {
  assert.equal(shouldRenderBotChannelTrigger({}), false);
  assert.equal(shouldRenderBotChannelTrigger({ workspacePath: "" }), false);
  assert.equal(shouldRenderBotChannelTrigger({ workspacePath: "   " }), false);
});

test("桌面（此前 isDesktop && workspacePath 语义）行为不变", () => {
  assert.equal(shouldRenderBotChannelTrigger({ workspacePath: "/Users/user/project" }), true);
});
