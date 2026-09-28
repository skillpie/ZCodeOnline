import assert from "node:assert/strict";
import test from "node:test";
import { shouldRenderWorkspaceHeader } from "../src/app-shell/workspaceHeaderVisibility.js";

test("chat 主视图渲染头部：不区分平台与任务/草稿态（Web 草稿态对齐桌面）", () => {
  assert.equal(shouldRenderWorkspaceHeader("chat"), true);
});

test("整页主视图（automations / plugin-store / skill-market / code-repository）不渲染工作区头部", () => {
  assert.equal(shouldRenderWorkspaceHeader("automations"), false);
  assert.equal(shouldRenderWorkspaceHeader("plugin-store"), false);
  assert.equal(shouldRenderWorkspaceHeader("skill-market"), false);
  assert.equal(shouldRenderWorkspaceHeader("code-repository"), false);
});
