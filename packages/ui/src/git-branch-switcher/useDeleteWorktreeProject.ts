import { useCallback } from "react";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import { hasRunningWorkspaceChat } from "@/lib/workspaceRemovalSafety.js";
import { logger } from "@/logger.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

interface UseDeleteWorktreeProjectOptions {
  /** worktree 项目的主目录（`.worktrees/` 下的检出路径）。 */
  worktreePath: string;
}

/**
 * 侧栏「删除项目」对 worktree 项目的语义：除了删除项目注册条目，还必须同步
 * 移除 `.worktrees/` 下的磁盘目录（git worktree remove）并删除创建时自动生成的
 * 副本分支，否则 worktree 目录会堆积在电脑里（用户决策：界面移除 ≠ 清理完成）。
 * 流程与旧单体侧栏 WorkspaceSidebarItem 的 handleDeleteWorktreeProject 一致：
 * 运行中对话确认 → 删除确认 → 先取分支名（目录还在时 listWorktrees 才能定位）
 * → removeWorktree → 删分支（未合并需二次确认 -D）→ 关 tab 并释放运行时。
 */
export function useDeleteWorktreeProject({ worktreePath }: UseDeleteWorktreeProjectOptions) {
  const { gitService, zcodeTaskService } = useBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const tabStoreApi = useTabStoreApi();

  const closeRemovedWorktreeTabs = useCallback(
    (removedWorktreePath: string) => {
      // 目录已随 worktree 移除：关闭本窗口打开该 worktree 的项目 tab，并释放运行时与任务缓存
      // （Windows 上不释放会残留占用已删目录的进程）。
      const normalized = removedWorktreePath.replace(/\\/g, "/");
      const tabStore = tabStoreApi.getState();
      for (const tab of tabStore.tabs) {
        if (!isWorkspaceTab(tab) || tab.workspacePath.replace(/\\/g, "/") !== normalized) {
          continue;
        }
        tabStore.closeTab(tab.id);
        releaseWorkspaceRuntimeAfterProjectRemoval({ tab, zcodeTaskService });
        invalidateTaskQueryCacheByScopes([
          {
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          },
        ]);
      }
    },
    [tabStoreApi, zcodeTaskService],
  );

  const deleteWorktreeProject = useCallback(async (): Promise<boolean> => {
    // git worktree/branch 操作一律以主树为解析上下文（`.worktrees/` 前段），与旧实现一致。
    const mainTreePath = worktreePath.replace(/\\/g, "/").split("/.worktrees/")[0] ?? worktreePath;
    const workspaceState = selectWorkspaceZCodeState(useZCodeSessionStore.getState(), worktreePath);
    if (hasRunningWorkspaceChat({ workspaceState, taskItems: [] })) {
      const runningConfirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.title" }),
        description: intl.formatMessage({
          id: "workspaceSidebar.removeRunningWorkspace.description",
        }),
        confirmLabel: intl.formatMessage({
          id: "workspaceSidebar.removeRunningWorkspace.confirm",
        }),
        confirmVariant: "destructive",
      });
      if (!runningConfirmed) {
        return false;
      }
    }

    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "workspaceSidebar.worktreeDeleteConfirm.title" }),
      description: intl.formatMessage(
        { id: "workspaceSidebar.worktreeDeleteConfirm.description" },
        { path: worktreePath },
      ),
      confirmLabel: intl.formatMessage({ id: "workspaceSidebar.worktreeDeleteConfirm.confirm" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) {
      return false;
    }

    try {
      // 先取分支名（目录还在时 listWorktrees 才能定位），再删目录，最后删分支。
      let branchName: string | null = null;
      try {
        const worktrees = await gitService.listWorktrees({ workspacePath: mainTreePath });
        branchName =
          worktrees.worktrees.find(
            (worktree) => worktree.path.replace(/\\/g, "/") === worktreePath.replace(/\\/g, "/"),
          )?.branchName ?? null;
      } catch (error: unknown) {
        logger.warn("[DeleteWorktreeProject] 查询 worktree 分支失败", {
          worktreePath,
          error: getErrorMessage(error),
        });
      }

      const removed = await gitService.removeWorktree({
        workspacePath: mainTreePath,
        worktreePath,
      });
      if (!removed.ok) {
        const code = removed.issues[0]?.code;
        logger.warn("[DeleteWorktreeProject] 删除 worktree 被阻塞", {
          worktreePath,
          issues: removed.issues.map((issue) => issue.code),
        });
        if (code === "worktree-not-found") {
          // 注册表里已无此 worktree（目录与注册均已被外部清理）→ 视为清理完成。
          toast(intl.formatMessage({ id: "git.worktree.toast.removed" }, { path: worktreePath }));
          closeRemovedWorktreeTabs(worktreePath);
          return true;
        }
        const issue = removed.issues[0];
        toast(
          issue?.detail?.trim() ||
            issue?.message.trim() ||
            intl.formatMessage({ id: "git.worktree.error.dirty" }),
        );
        return false;
      }

      // 副本分支是创建 worktree 时自动生成的，随 worktree 一起删除，避免污染分支列表。
      if (branchName) {
        let branchResult = await gitService.deleteBranch({
          workspacePath: mainTreePath,
          branchName,
        });
        if (!branchResult.ok && branchResult.issues[0]?.code === "branch-not-fully-merged") {
          const forceConfirmed = await requestConfirmation({
            title: intl.formatMessage({ id: "git.branchSwitcher.deleteConfirm.forceTitle" }),
            description: intl.formatMessage(
              { id: "git.branchSwitcher.deleteConfirm.forceDescription" },
              { branchName },
            ),
            confirmLabel: intl.formatMessage({
              id: "git.branchSwitcher.deleteConfirm.forceConfirm",
            }),
            cancelLabel: intl.formatMessage({ id: "common.cancel" }),
            confirmVariant: "destructive",
          });
          if (forceConfirmed) {
            branchResult = await gitService.deleteBranch({
              workspacePath: mainTreePath,
              branchName,
              force: true,
            });
          }
        }
        if (!branchResult.ok) {
          logger.warn("[DeleteWorktreeProject] worktree 分支删除失败（目录已删除）", {
            worktreePath,
            branchName,
            issues: branchResult.issues.map((issue) => issue.code),
          });
        }
      }

      logger.info("[DeleteWorktreeProject] 删除 worktree 项目成功", { worktreePath });
      toast(intl.formatMessage({ id: "git.worktree.toast.deleted" }, { path: worktreePath }));
      closeRemovedWorktreeTabs(worktreePath);
      return true;
    } catch (error: unknown) {
      logger.warn("[DeleteWorktreeProject] 删除 worktree 项目失败", {
        worktreePath,
        error: getErrorMessage(error),
      });
      toast(getErrorMessage(error));
      return false;
    }
  }, [closeRemovedWorktreeTabs, gitService, intl, requestConfirmation, worktreePath]);

  return { deleteWorktreeProject };
}
