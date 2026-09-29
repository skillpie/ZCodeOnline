import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDefaultCommitDialogActionId,
  type GitCommitDialogActionId,
} from "../src/git-action-menu/display.js";

test("提交弹窗默认选中「提交并推送」，回车直达最常用动作", () => {
  const enabledActionIds: GitCommitDialogActionId[] = ["commit", "commitAndPush", "push"];
  assert.equal(resolveDefaultCommitDialogActionId(enabledActionIds), "commitAndPush");
});

test("「提交并推送」不可用时回落到按序第一个可用动作", () => {
  assert.equal(resolveDefaultCommitDialogActionId(["commit"]), "commit");
  assert.equal(resolveDefaultCommitDialogActionId(["push"]), "push");
  assert.equal(resolveDefaultCommitDialogActionId(["commit", "push"]), "commit");
});

test("全部动作不可用时保持「提交并推送」占位，回车由 disabled 守卫拦截", () => {
  assert.equal(resolveDefaultCommitDialogActionId([]), "commitAndPush");
});
