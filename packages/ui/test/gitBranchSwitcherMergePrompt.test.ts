import assert from "node:assert/strict";
import { test } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// 2026-10-11 用户决策：分支弹层「合入」的语义是把远端分支的最新提交合入当前分支，
// 而非合并可能落后的本地引用。动作本身不下发 git 命令，提示词文案就是该行为的
// 事实规范，因此用测试锁定文案必须包含「先 fetch、合并远端分支」语义。
test("合入提示词要求先获取远端并合并远端分支，本地分支仅作无远端时的回落", () => {
  for (const messages of [zhCN, enUS]) {
    const prompt = messages["git.branchSwitcher.mergePrompt"];
    assert.ok(prompt.length > 0, "mergePrompt 文案缺失");
    assert.match(prompt, /fetch/i);
    assert.match(prompt, /远端|remote/i);
    assert.match(prompt, /\{branchName\}/);
  }
});
