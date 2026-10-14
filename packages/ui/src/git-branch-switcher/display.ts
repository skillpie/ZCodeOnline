import type {
  GitBranchMutationIssueCode,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitFileChange,
  GitHeadRefType,
  GitLocalBranch,
  GitWorktreeMutationIssue,
} from "@zcode/shared";

interface GitDirtySectionLike {
  changes: Array<{
    path: string;
  }>;
}

interface GitDirtyDatasetsLike {
  staged: {
    sections: GitDirtySectionLike[];
  };
  unstaged: {
    sections: GitDirtySectionLike[];
  };
}

export interface GitBranchCommitPreviewFile {
  stagePath: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  kind: GitFileChange["kind"];
  added: number;
  removed: number;
}

export function getGitDirtyFileCount(datasets: GitDirtyDatasetsLike): number {
  const dirtyPaths = new Set<string>();
  for (const dataset of [datasets.unstaged, datasets.staged]) {
    for (const section of dataset.sections) {
      for (const change of section.changes) {
        dirtyPaths.add(change.path);
      }
    }
  }

  return dirtyPaths.size;
}

export function resolveGitBranchTriggerLabel(options: {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  detachedLabel: string;
  fallbackLabel: string;
}): string {
  if (options.headRefType === "detached") {
    return options.detachedLabel;
  }

  const normalizedBranchName = options.currentBranchName?.trim() ?? "";
  return normalizedBranchName.length > 0 ? normalizedBranchName : options.fallbackLabel;
}

export function matchesGitBranchSearch(branchName: string, searchText: string): boolean {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  if (normalizedSearchText.length === 0) {
    return true;
  }

  return branchName.trim().toLocaleLowerCase().includes(normalizedSearchText);
}

export function getPrimaryGitBranchIssue(
  issues: readonly GitBranchMutationIssue[],
): GitBranchMutationIssue | null {
  return issues[0] ?? null;
}

export function isGitBranchCommitAssistIssue(
  code: GitBranchMutationIssueCode | undefined,
): boolean {
  return (
    code === "tracked-changes-would-be-overwritten" ||
    code === "untracked-changes-would-be-overwritten"
  );
}

export function resolveGitBranchIssueMessageId(
  issue: GitBranchMutationIssue | null,
): string | null {
  switch (issue?.code) {
    case "invalid-branch-name":
      return "git.branchSwitcher.error.invalidBranchName";
    case "branch-already-exists":
      return "git.branchSwitcher.error.branchAlreadyExists";
    case "target-branch-not-found":
      return "git.branchSwitcher.error.targetBranchNotFound";
    case "tracked-changes-would-be-overwritten":
      return "git.branchSwitcher.error.trackedOverwrite";
    case "untracked-changes-would-be-overwritten":
      return "git.branchSwitcher.error.untrackedOverwrite";
    case "conflicts-present":
      return "git.branchSwitcher.error.conflictsPresent";
    case "operation-in-progress":
      return "git.branchSwitcher.error.operationInProgress";
    case "branch-in-other-worktree":
      return "git.branchSwitcher.error.branchInOtherWorktree";
    case "branch-in-main-worktree":
      return "git.branchSwitcher.error.branchInMainWorktree";
    case "branch-is-current":
      return "git.branchSwitcher.error.branchIsCurrent";
    case "branch-not-fully-merged":
      return "git.branchSwitcher.error.branchNotFullyMerged";
    default:
      return null;
  }
}

/** worktree 变更 issue code → toast 文案 id；与分支 issue 同码的沿用分支文案。 */
export function resolveGitWorktreeIssueMessageId(issue: GitWorktreeMutationIssue): string | null {
  switch (issue.code) {
    case "invalid-branch-name":
      return "git.branchSwitcher.error.invalidBranchName";
    case "branch-already-exists":
      return "git.branchSwitcher.error.branchAlreadyExists";
    case "branch-not-found":
      return "git.branchSwitcher.error.targetBranchNotFound";
    case "branch-in-other-worktree":
      return "git.branchSwitcher.error.branchInOtherWorktree";
    case "operation-in-progress":
      return "git.branchSwitcher.error.operationInProgress";
    case "invalid-worktree-name":
      return "git.worktree.error.invalidName";
    case "worktree-name-conflict":
      return "git.worktree.error.nameConflict";
    case "worktree-dirty":
      return "git.worktree.error.dirty";
    case "worktree-not-found":
      return "git.worktree.error.notFound";
    case "worktree-detached":
      return "git.worktree.error.detached";
    default:
      return null;
  }
}

/** worktree 路径归一：仅统一分隔符；同一 git 输出的盘符大小写一致，不做大小写折叠。 */
function normalizeWorktreePathForCompare(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

export type GitBranchDeleteWorktreeOccupancy =
  | { kind: "not-occupied" }
  | { kind: "main-worktree" }
  | { kind: "linked-worktree"; worktreePath: string };

/**
 * 解析「删除分支被 branch-in-other-worktree 阻塞」时的占用来源。
 * getLocalBranches 的 worktreePath 指向检出该分支的工作树（主树或 linked worktree），
 * mainTreeRoot 用于区分二者：只有 linked worktree 可以走“移除后重删”的恢复路径。
 */
export function resolveGitBranchDeleteWorktreeOccupancy(options: {
  branchName: string;
  mainTreeRoot: string | null;
  branches: ReadonlyArray<Pick<GitLocalBranch, "name" | "worktreePath">>;
}): GitBranchDeleteWorktreeOccupancy {
  const branchName = options.branchName.trim();
  const worktreePath = options.branches.find((branch) => branch.name === branchName)?.worktreePath;
  const normalizedWorktreePath = worktreePath?.trim() ?? "";
  if (normalizedWorktreePath.length === 0) {
    return { kind: "not-occupied" };
  }

  const mainTreeRoot = options.mainTreeRoot?.trim() ?? "";
  if (
    mainTreeRoot.length > 0 &&
    normalizeWorktreePathForCompare(mainTreeRoot) ===
      normalizeWorktreePathForCompare(normalizedWorktreePath)
  ) {
    return { kind: "main-worktree" };
  }

  return { kind: "linked-worktree", worktreePath: normalizedWorktreePath };
}

export function resolveGitBranchSuccessMessageId(
  result: Pick<GitBranchMutationResult, "action" | "created" | "didChange">,
): string | null {
  if (!result.didChange) {
    return null;
  }

  if (result.action === "delete") {
    return "git.branchSwitcher.toast.deleteSuccess";
  }

  if (result.action === "create-and-switch" || result.created) {
    return "git.branchSwitcher.toast.createSuccess";
  }

  return "git.branchSwitcher.toast.switchSuccess";
}

export function summarizeGitBranchIssuePaths(
  paths: readonly string[] | undefined,
  limit = 2,
): {
  visiblePaths: string[];
  remainingCount: number;
} {
  const normalizedPaths = (paths ?? []).filter((path) => path.trim().length > 0);
  return {
    visiblePaths: normalizedPaths.slice(0, limit),
    remainingCount: Math.max(0, normalizedPaths.length - limit),
  };
}

export function buildGitBranchCommitPreviewFiles(
  changes: readonly GitFileChange[],
): GitBranchCommitPreviewFile[] {
  const previewByRepoPath = new Map<string, GitBranchCommitPreviewFile>();

  for (const change of changes) {
    const existing = previewByRepoPath.get(change.repoRelativePath);
    if (!existing) {
      previewByRepoPath.set(change.repoRelativePath, {
        stagePath: change.path,
        repoRelativePath: change.repoRelativePath,
        workspaceRelativePath: change.workspaceRelativePath,
        kind: change.kind,
        added: change.added,
        removed: change.removed,
      });
      continue;
    }

    previewByRepoPath.set(change.repoRelativePath, {
      ...existing,
      // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
      // 这里把增删行数聚合后再展示，避免阻塞卡片和提交弹窗看到两条重复记录。
      added: existing.added + change.added,
      removed: existing.removed + change.removed,
      kind: existing.kind === change.kind ? existing.kind : "modified",
    });
  }

  return Array.from(previewByRepoPath.values()).sort((left, right) =>
    left.repoRelativePath.localeCompare(right.repoRelativePath),
  );
}

export function getGitBranchCommitTotals(files: readonly GitBranchCommitPreviewFile[]): {
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
} {
  return files.reduce(
    (result, file) => {
      result.fileCount += 1;
      result.totalAdded += file.added;
      result.totalRemoved += file.removed;
      return result;
    },
    {
      fileCount: 0,
      totalAdded: 0,
      totalRemoved: 0,
    },
  );
}

export function selectGitBranchAffectedFiles(options: {
  files: readonly GitBranchCommitPreviewFile[];
  issuePaths: readonly string[] | undefined;
}): GitBranchCommitPreviewFile[] {
  const fileByRepoPath = new Map(
    options.files.map((file) => [file.repoRelativePath, file] as const),
  );
  const normalizedIssuePaths = (options.issuePaths ?? []).filter((path) => path.trim().length > 0);

  return normalizedIssuePaths.map(
    (repoRelativePath) =>
      fileByRepoPath.get(repoRelativePath) ?? {
        stagePath: repoRelativePath,
        repoRelativePath,
        workspaceRelativePath: repoRelativePath,
        kind: "modified",
        added: 0,
        removed: 0,
      },
  );
}

export function buildGitBranchAutoCommitMessage(targetBranchName: string): string {
  const normalizedBranchName = targetBranchName.trim();
  return normalizedBranchName.length > 0
    ? `chore: checkpoint before switching to ${normalizedBranchName}`
    : "chore: checkpoint before switching branches";
}
