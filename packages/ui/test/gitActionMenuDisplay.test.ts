import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmGitPush,
  canPushGitBranch,
  resolveDefaultCommitDialogActionId,
  resolveGitActionMenuPrimaryAction,
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

test("主按钮裁决优先提交：有待提交时即使同时有未推送提交也先展示提交", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: true,
      pushEnabled: true,
    }),
    "commit",
  );
});

test("主按钮裁决：没有待提交但有未推送提交（或无上游新分支）时改为推送", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: false,
      pushEnabled: true,
    }),
    "push",
  );
});

test("主按钮裁决：干净且与远程同步时不占用槽位，头部换拉取入口", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: false,
      pushEnabled: false,
    }),
    null,
  );
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: false,
      commitEnabled: true,
      pushEnabled: true,
    }),
    null,
  );
});

test("canPushGitBranch：领先上游或尚无上游时可推送，同步中、detached HEAD、空分支名不可", () => {
  assert.equal(
    canPushGitBranch({
      headRefType: "branch",
      branchName: "feature",
      trackingBranchName: "origin/feature",
      ahead: 2,
    }),
    true,
  );
  assert.equal(
    canPushGitBranch({
      headRefType: "branch",
      branchName: "feature",
      trackingBranchName: null,
      ahead: 0,
    }),
    true,
  );
  assert.equal(
    canPushGitBranch({
      headRefType: "branch",
      branchName: "feature",
      trackingBranchName: "origin/feature",
      ahead: 0,
    }),
    false,
  );
  assert.equal(
    canPushGitBranch({
      headRefType: "detached",
      branchName: null,
      trackingBranchName: "origin/main",
      ahead: 1,
    }),
    false,
  );
  assert.equal(
    canPushGitBranch({
      headRefType: "branch",
      branchName: "  ",
      trackingBranchName: null,
      ahead: 0,
    }),
    false,
  );
});

test("推送确认守卫：仅「无错误详情、非 pending、有可推送提交」时按钮与 ⌘⏎ 可触发", () => {
  assert.equal(
    canConfirmGitPush({ hasError: false, mutationPending: false, pushEnabled: true }),
    true,
  );
  // 错误详情态的主动作是「关闭」，快捷键不触发重试。
  assert.equal(
    canConfirmGitPush({ hasError: true, mutationPending: false, pushEnabled: true }),
    false,
  );
  assert.equal(
    canConfirmGitPush({ hasError: false, mutationPending: true, pushEnabled: true }),
    false,
  );
  assert.equal(
    canConfirmGitPush({ hasError: false, mutationPending: false, pushEnabled: false }),
    false,
  );
});
