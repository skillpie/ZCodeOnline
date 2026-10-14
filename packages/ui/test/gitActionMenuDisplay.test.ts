import assert from "node:assert/strict";
import { describe, expect, it, test } from "vitest";
import {
  canConfirmGitPush,
  canPushGitBranch,
  canRenderGitActionMenu,
  canUseGitActionMenu,
  resolveDefaultCommitDialogActionId,
  resolveGitActionMenuPrimaryAction,
  resolveGitSyncDispatch,
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

describe("canUseGitActionMenu", () => {
  it("keeps the entry rendered but disables actions when git is unavailable", () => {
    expect(
      canUseGitActionMenu({
        isGitAvailable: false,
        isRepository: false,
      }),
    ).toBe(false);

    expect(
      canUseGitActionMenu({
        isGitAvailable: true,
        isRepository: false,
      }),
    ).toBe(false);

    expect(
      canUseGitActionMenu({
        isGitAvailable: true,
        isRepository: true,
      }),
    ).toBe(true);
  });
});

describe("canRenderGitActionMenu", () => {
  it("renders only when commit or push is available", () => {
    expect(
      canRenderGitActionMenu({
        actionAvailable: true,
        commitEnabled: true,
        pushEnabled: false,
      }),
    ).toBe(true);

    expect(
      canRenderGitActionMenu({
        actionAvailable: true,
        commitEnabled: false,
        pushEnabled: true,
      }),
    ).toBe(true);

    expect(
      canRenderGitActionMenu({
        actionAvailable: true,
        commitEnabled: false,
        pushEnabled: false,
      }),
    ).toBe(false);
  });

  it("hides when git actions are unavailable", () => {
    expect(
      canRenderGitActionMenu({
        actionAvailable: false,
        commitEnabled: true,
        pushEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("resolveGitSyncDispatch（2026-10-14 统一「同步」按钮）", () => {
  it("本地有待提交/待推送时主动作优先，即使拉取兜底也可用", () => {
    expect(resolveGitSyncDispatch({ primaryActionId: "commit", pullAvailable: true })).toBe(
      "commit",
    );
    expect(resolveGitSyncDispatch({ primaryActionId: "push", pullAvailable: true })).toBe("push");
  });

  it("主动作不可用（干净且同步中/已落后）且拉取可用时改派快进拉取", () => {
    expect(resolveGitSyncDispatch({ primaryActionId: null, pullAvailable: true })).toBe("pull");
  });

  it("两侧都不可用（detached HEAD 且无上游）时返回 null，按钮置灰", () => {
    expect(resolveGitSyncDispatch({ primaryActionId: null, pullAvailable: false })).toBeNull();
  });
});
