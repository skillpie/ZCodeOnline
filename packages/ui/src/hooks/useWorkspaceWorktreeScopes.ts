import { create } from "zustand";
import { useEffect, useMemo } from "react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { isRemoteWorkspaceTarget } from "@/lib/workspaceServiceResolver.js";
import { useServices } from "@/hooks/useServices.js";
import type { WorktreeDirRef } from "@/lib/worktreeTaskScope.js";
import { logger } from "@/logger.js";

/**
 * 按 worktree 目录名发现主工作区的 git worktree（`.worktrees/*`），
 * 供主工作区会话列表合并展示 worktree 会话。git 元数据是唯一事实；
 * 发现失败（非 git 仓库 / git 不可用）静默降级为空。
 */
interface WorktreeScopesStoreState {
  dirsByWorkspacePath: Record<string, WorktreeDirRef[]>;
  setDirs: (workspacePath: string, dirs: WorktreeDirRef[]) => void;
  /** 清除缓存条目，触发使用方重新发现（worktree 增删/重命名后调用）。 */
  invalidate: (workspacePath: string) => void;
}

export const useWorktreeScopesStore = create<WorktreeScopesStoreState>((set) => ({
  dirsByWorkspacePath: {},
  setDirs: (workspacePath, dirs) =>
    set((state) => {
      const previous = state.dirsByWorkspacePath[workspacePath];
      if (
        previous &&
        previous.length === dirs.length &&
        previous.every((dir, index) => dir.path === dirs[index]?.path)
      ) {
        // 引用稳定化：目录列表没变时保持旧引用，避免使用方 effect 反复重拉。
        return state;
      }
      return {
        dirsByWorkspacePath: { ...state.dirsByWorkspacePath, [workspacePath]: dirs },
      };
    }),
  invalidate: (workspacePath) =>
    set((state) => {
      if (!(workspacePath in state.dirsByWorkspacePath)) {
        return state;
      }
      const next = { ...state.dirsByWorkspacePath };
      delete next[workspacePath];
      return { dirsByWorkspacePath: next };
    }),
}));

/**
 * 发现各 project workspace 的 `.worktrees/*` worktree 目录。
 * gitService.listWorktrees 是唯一事实来源；只保留位于 `<workspacePath>/.worktrees/`
 * 下的条目（用户规则：`.worktrees` 目录下的才是 worktree）。
 */
export function useWorkspaceWorktreeScopes(
  workspaceTabs: WorkspaceTabState[],
): Record<string, WorktreeDirRef[]> {
  const { gitService } = useServices();
  const dirsByWorkspacePath = useWorktreeScopesStore((state) => state.dirsByWorkspacePath);
  const setDirs = useWorktreeScopesStore((state) => state.setDirs);

  const localWorkspacePaths = useMemo(
    () =>
      workspaceTabs.filter((tab) => !isRemoteWorkspaceTarget(tab)).map((tab) => tab.workspacePath),
    [workspaceTabs],
  );

  const pathsKey = localWorkspacePaths.join("\n");
  useEffect(() => {
    const workspacePaths = pathsKey.split("\n").filter(Boolean);
    const missing = workspacePaths.filter(
      (path) => !(path in useWorktreeScopesStore.getState().dirsByWorkspacePath),
    );
    if (missing.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      for (const workspacePath of missing) {
        try {
          const list = await gitService.listWorktrees({ workspacePath });
          if (cancelled) {
            return;
          }
          const marker = "/.worktrees/";
          const dirs = list.worktrees
            .filter((worktree) => worktree.path.replace(/\\/g, "/").includes(marker))
            .map((worktree) => ({
              dirName:
                worktree.path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? worktree.path,
              path: worktree.path,
            }));
          useWorktreeScopesStore.getState().setDirs(workspacePath, dirs);
        } catch (error) {
          if (cancelled) {
            return;
          }
          // 非 git 仓库 / git 不可用：静默降级为无 worktree scope（与现状一致）。
          logger.info("[useWorkspaceWorktreeScopes] 发现 worktree 失败，按无 worktree 处理", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
          useWorktreeScopesStore.getState().setDirs(workspacePath, []);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [gitService, pathsKey]);

  return dirsByWorkspacePath;
}

/** worktree 增删/重命名后由操作方调用：清除缓存并让使用方重新发现。 */
export function refreshWorktreeScopes(workspacePath: string): void {
  useWorktreeScopesStore.getState().invalidate(workspacePath);
}
