import type { GitRepositorySummary } from "@zcode/shared";

type GitActionMenuPrimaryActionId = "commit" | "push";

export type GitCommitDialogActionId = "commit" | "commitAndPush" | "push";

export const DEFAULT_COMMIT_DIALOG_ACTION_ID: GitCommitDialogActionId = "commitAndPush";

export function resolveDefaultCommitDialogActionId(
  enabledActionIds: readonly GitCommitDialogActionId[],
): GitCommitDialogActionId {
  // 提交弹窗默认选中「提交并推送」，回车直达最常用动作；不可用时回落到按序第一个可用动作。
  if (enabledActionIds.includes(DEFAULT_COMMIT_DIALOG_ACTION_ID)) {
    return DEFAULT_COMMIT_DIALOG_ACTION_ID;
  }

  return enabledActionIds[0] ?? DEFAULT_COMMIT_DIALOG_ACTION_ID;
}

export function canUseGitActionMenu(
  summary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">,
): boolean {
  return summary.isGitAvailable && summary.isRepository;
}

export function resolveGitActionMenuPrimaryAction(options: {
  actionAvailable: boolean;
  commitEnabled: boolean;
  pushEnabled: boolean;
}): GitActionMenuPrimaryActionId | null {
  // 关键业务逻辑：主按钮只承载提交或推送；创建分支保留在下拉菜单里。
  // 这样干净仓库仍可通过菜单创建分支，但不会把“提交或推送”误触发为创建分支。
  if (options.actionAvailable && options.commitEnabled) {
    return "commit";
  }

  if (options.actionAvailable && options.pushEnabled) {
    return "push";
  }

  return null;
}

export function canPushGitBranch(
  summary: Pick<
    GitRepositorySummary,
    "headRefType" | "branchName" | "trackingBranchName" | "ahead"
  >,
): boolean {
  const branchName = summary.branchName?.trim() ?? "";
  if (summary.headRefType !== "branch" || branchName.length === 0) {
    return false;
  }

  return !summary.trackingBranchName || summary.ahead > 0;
}
