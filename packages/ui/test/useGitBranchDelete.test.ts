// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  confirmResponses,
  closeTab,
  gitService,
  invalidateTaskQueryCacheByScopes,
  toast,
  workspaceStatesByPath,
  zcodeTaskService,
} = vi.hoisted(() => ({
  confirmResponses: [] as Array<boolean>,
  closeTab: vi.fn(),
  gitService: {
    deleteBranch: vi.fn(),
    getLocalBranches: vi.fn(),
    removeWorktree: vi.fn(),
  },
  invalidateTaskQueryCacheByScopes: vi.fn(),
  toast: vi.fn(),
  workspaceStatesByPath: new Map<string, unknown>(),
  zcodeTaskService: {
    releaseWorkspacePreparation: vi.fn(async () => {}),
  },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ gitService, zcodeTaskService }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => async () => confirmResponses.shift() ?? false,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => ({
    getState: () => ({
      tabs: [
        { id: "tab-worktree", kind: "workspace", workspacePath: "/repo/.worktrees/765160" },
        { id: "tab-main", kind: "workspace", workspacePath: "/repo" },
        { id: "tab-settings", kind: "settings" },
      ],
      closeTab,
    }),
  }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: { getState: () => ({}) },
  selectWorkspaceZCodeState: (_state: unknown, workspacePath: string) =>
    workspaceStatesByPath.get(workspacePath) ?? {
      draftRuntime: { status: "idle" },
      taskRuntimeByTaskId: {},
    },
}));
vi.mock("@/store/taskQueryCacheStore.js", () => ({ invalidateTaskQueryCacheByScopes }));

import { useGitBranchDelete } from "@/git-branch-switcher/useGitBranchDelete.js";

const WORKTREE_PATH = "/repo/.worktrees/765160";

function makeMutationResult(overrides: Record<string, unknown>) {
  overrides.branchName = overrides.branchName ?? "feat/765160";
  return {
    ok: false,
    action: "delete",
    didChange: false,
    created: false,
    summary: { branchName: "main", headRefType: "branch" },
    issues: [],
    ...overrides,
  };
}

function makeBranchListResult() {
  return {
    headRefType: "branch",
    currentBranchName: "main",
    mainTreeRoot: "/repo",
    branches: [
      { name: "main", worktreePath: "/repo" },
      { name: "feat/765160", worktreePath: WORKTREE_PATH },
    ],
  };
}

describe("useGitBranchDelete", () => {
  beforeEach(() => {
    confirmResponses.length = 0;
    closeTab.mockClear();
    gitService.deleteBranch.mockReset();
    gitService.getLocalBranches.mockReset();
    gitService.removeWorktree.mockReset();
    invalidateTaskQueryCacheByScopes.mockClear();
    toast.mockClear();
    zcodeTaskService.releaseWorkspacePreparation.mockClear();
    workspaceStatesByPath.clear();
  });

  it("deletes a free branch after the single confirmation", async () => {
    confirmResponses.push(true);
    gitService.deleteBranch.mockResolvedValue(
      makeMutationResult({ ok: true, didChange: true, branchName: "feat/free" }),
    );
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/free");

    expect(gitService.deleteBranch).toHaveBeenCalledTimes(1);
    expect(gitService.deleteBranch).toHaveBeenCalledWith({
      workspacePath: "/repo",
      branchName: "feat/free",
    });
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith("feat/free");
    expect(toast).toHaveBeenCalledWith("git.branchSwitcher.toast.deleteSuccess");
  });

  it("removes the occupying worktree after confirmation and retries the delete", async () => {
    confirmResponses.push(true, true);
    gitService.deleteBranch
      .mockResolvedValueOnce(makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }))
      .mockResolvedValueOnce(makeMutationResult({ ok: true, didChange: true }));
    gitService.getLocalBranches.mockResolvedValue(makeBranchListResult());
    gitService.removeWorktree.mockResolvedValue({ ok: true, worktree: null, issues: [] });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.removeWorktree).toHaveBeenCalledWith({
      workspacePath: "/repo",
      worktreePath: WORKTREE_PATH,
    });
    expect(gitService.deleteBranch).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledWith("feat/765160");
    // 目录已删除：只关闭打开该 worktree 的项目 tab，并释放其运行时与任务缓存。
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith("tab-worktree");
    expect(zcodeTaskService.releaseWorkspacePreparation).toHaveBeenCalledWith({
      workspacePath: WORKTREE_PATH,
    });
    expect(invalidateTaskQueryCacheByScopes).toHaveBeenCalledWith([
      { workspacePath: WORKTREE_PATH },
    ]);
  });

  it("keeps the force-delete confirmation flow after worktree removal", async () => {
    confirmResponses.push(true, true, true);
    gitService.deleteBranch
      .mockResolvedValueOnce(makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }))
      .mockResolvedValueOnce(makeMutationResult({ issues: [{ code: "branch-not-fully-merged" }] }))
      .mockResolvedValueOnce(makeMutationResult({ ok: true, didChange: true }));
    gitService.getLocalBranches.mockResolvedValue(makeBranchListResult());
    gitService.removeWorktree.mockResolvedValue({ ok: true, worktree: null, issues: [] });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.removeWorktree).toHaveBeenCalledTimes(1);
    expect(gitService.deleteBranch).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      branchName: "feat/765160",
      force: true,
    });
    expect(onDeleted).toHaveBeenCalledWith("feat/765160");
  });

  it("stops with a dedicated toast when the branch is held by the main tree", async () => {
    confirmResponses.push(true);
    gitService.deleteBranch.mockResolvedValue(
      makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }),
    );
    gitService.getLocalBranches.mockResolvedValue({
      ...makeBranchListResult(),
      branches: [{ name: "feat/765160", worktreePath: "/repo" }],
    });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(gitService.deleteBranch).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("git.branchSwitcher.error.deleteBlockedByMainWorktree");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("aborts without removing the worktree when the removal confirmation is declined", async () => {
    confirmResponses.push(true, false);
    gitService.deleteBranch.mockResolvedValue(
      makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }),
    );
    gitService.getLocalBranches.mockResolvedValue(makeBranchListResult());
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(gitService.deleteBranch).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("aborts via the running-workspace confirmation before removing a busy worktree", async () => {
    confirmResponses.push(true, false);
    gitService.deleteBranch.mockResolvedValue(
      makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }),
    );
    gitService.getLocalBranches.mockResolvedValue(makeBranchListResult());
    workspaceStatesByPath.set(WORKTREE_PATH, {
      draftRuntime: { status: "idle" },
      taskRuntimeByTaskId: { "task-1": { status: "streaming" } },
    });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    // 运行中确认被拒：不再弹出移除确认，也不移除 worktree。
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("keeps the worktree-open tab cleanup when the worktree still exists", async () => {
    // 删除确认 → 运行中确认 → 移除确认，全部同意。
    confirmResponses.push(true, true, true);
    gitService.deleteBranch
      .mockResolvedValueOnce(makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }))
      .mockResolvedValueOnce(makeMutationResult({ ok: true, didChange: true }));
    gitService.getLocalBranches.mockResolvedValue(makeBranchListResult());
    gitService.removeWorktree.mockResolvedValue({ ok: true, worktree: null, issues: [] });
    workspaceStatesByPath.set(WORKTREE_PATH, {
      draftRuntime: { status: "idle" },
      taskRuntimeByTaskId: { "task-1": { status: "streaming" } },
    });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    // 运行中确认（true）→ 移除确认（true）→ 移除 → 关 tab。
    expect(confirmResponses).toHaveLength(0);
    expect(gitService.removeWorktree).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith("tab-worktree");
    expect(onDeleted).toHaveBeenCalledWith("feat/765160");
  });

  it("surfaces a dirty-worktree blocker and skips the branch retry", async () => {
    confirmResponses.push(true, true);
    gitService.deleteBranch.mockResolvedValue(
      makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }),
    );
    gitService.getLocalBranches.mockResolvedValue(makeBranchListResult());
    gitService.removeWorktree.mockResolvedValue({
      ok: false,
      worktree: null,
      issues: [{ code: "worktree-dirty" }],
    });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.deleteBranch).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("git.worktree.error.dirty");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("retries the delete when the occupying worktree vanished externally", async () => {
    confirmResponses.push(true);
    gitService.deleteBranch
      .mockResolvedValueOnce(makeMutationResult({ issues: [{ code: "branch-in-other-worktree" }] }))
      .mockResolvedValueOnce(makeMutationResult({ ok: true, didChange: true }));
    gitService.getLocalBranches.mockResolvedValue({
      ...makeBranchListResult(),
      branches: [{ name: "feat/765160", worktreePath: null }],
    });
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(gitService.deleteBranch).toHaveBeenCalledTimes(2);
    expect(onDeleted).toHaveBeenCalledWith("feat/765160");
  });

  it("still force-confirms unmerged branches on the plain path", async () => {
    confirmResponses.push(true, true);
    gitService.deleteBranch
      .mockResolvedValueOnce(makeMutationResult({ issues: [{ code: "branch-not-fully-merged" }] }))
      .mockResolvedValueOnce(
        makeMutationResult({ ok: true, didChange: true, branchName: "feat/unmerged" }),
      );
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/unmerged");

    expect(gitService.deleteBranch).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      branchName: "feat/unmerged",
      force: true,
    });
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith("feat/unmerged");
  });

  it("does nothing when the first confirmation is declined", async () => {
    confirmResponses.push(false);
    const onDeleted = vi.fn();

    const { result } = renderHook(() => useGitBranchDelete({ workspacePath: "/repo", onDeleted }));
    await result.current.deleteBranch("feat/765160");

    expect(gitService.deleteBranch).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
