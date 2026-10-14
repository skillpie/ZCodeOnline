import { useCallback } from "react";
import type { GitWorktreeMutationIssue } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  resolveGitBranchDeleteWorktreeOccupancy,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  resolveGitWorktreeIssueMessageId,
} from "@/git-branch-switcher/display.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import { hasRunningWorkspaceChat } from "@/lib/workspaceRemovalSafety.js";
import { logger } from "@/logger.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

interface UseGitBranchDeleteOptions {
  workspacePath: string;
  /** 删除成功后从分支投影移除该分支（分支投影由调用方持有）。 */
  onDeleted: (branchName: string) => void;
}

/**
 * 分支行「删除分支」流程：确认弹窗 → 安全删（git branch -d，仅删已合并分支）→
 * git 拒绝未合并时二次确认“强制删除将丢提交” → 携带 force 重试（-D）。
 * 分支被其他 worktree 检出时不以 toast 死路收场：解析占用方后允许“移除该 worktree
 * 再重删分支”（主树占用除外，只能引导用户先把主工作区切走）。
 * 破坏性动作配悬停浮现（GitBranchListRow）+ 确认弹窗双保险。
 */
export function useGitBranchDelete({ workspacePath, onDeleted }: UseGitBranchDeleteOptions) {
  const { gitService, zcodeTaskService } = useServices();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const tabStoreApi = useTabStoreApi();

  const notifyFailure = useCallback(
    (issues: Parameters<typeof resolveGitBranchIssueMessageId>[0][], fallbackName: string) => {
      const issue = issues[0] ?? null;
      const messageId = resolveGitBranchIssueMessageId(issue);
      if (messageId) {
        toast(intl.formatMessage({ id: messageId }, { branchName: fallbackName }));
        return;
      }

      const fallbackMessage = issue?.detail?.trim() || issue?.message.trim();
      toast(
        fallbackMessage && fallbackMessage.length > 0
          ? fallbackMessage
          : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
      );
    },
    [intl],
  );

  const notifyWorktreeFailure = useCallback(
    (issues: GitWorktreeMutationIssue[]) => {
      const issue = issues[0];
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      const messageId = resolveGitWorktreeIssueMessageId(issue);
      if (!messageId) {
        const fallbackMessage = issue.detail?.trim() || issue.message.trim();
        toast(
          fallbackMessage.length > 0
            ? fallbackMessage
            : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
        );
        return;
      }

      toast(intl.formatMessage({ id: messageId }, { detail: issue.detail ?? "" }));
    },
    [intl],
  );

  const closeRemovedWorktreeTabs = useCallback(
    (worktreePath: string) => {
      // 目录已随 worktree 移除：关闭本窗口打开该 worktree 的项目 tab，并释放运行时与任务缓存，
      // 清理序列与侧边栏「删除 worktree 项目」保持一致（Windows 上不释放会残留占用目录的进程）。
      const normalized = worktreePath.replace(/\\/g, "/");
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

  /**
   * branch-in-other-worktree 的恢复路径：解析占用方 →（运行中确认 →）移除确认 →
   * 移除 worktree 并清理打开它的 tab。返回 ready 表示阻塞已解除、可以重试删分支。
   */
  const removeOccupyingWorktree = useCallback(
    async (branchName: string): Promise<{ outcome: "aborted" | "ready" }> => {
      const branchList = await gitService.getLocalBranches({ workspacePath });
      const occupancy = resolveGitBranchDeleteWorktreeOccupancy({
        branchName,
        mainTreeRoot: branchList.mainTreeRoot,
        branches: branchList.branches,
      });

      if (occupancy.kind === "main-worktree") {
        // 主树占用无法靠删 worktree 解除：引导用户先把主工作区切到其他分支。
        toast(
          intl.formatMessage(
            { id: "git.branchSwitcher.error.deleteBlockedByMainWorktree" },
            { branchName },
          ),
        );
        return { outcome: "aborted" };
      }

      if (occupancy.kind === "not-occupied") {
        // deleteBranch 判定占用后、本次查询前 worktree 已被外部清理：阻塞已消失，直接重删。
        logger.info("[GitBranchDelete] 占用 worktree 已被外部清理，直接重试删除分支", {
          workspacePath,
          branchName,
        });
        return { outcome: "ready" };
      }

      // 占用它的 worktree 可能还有运行中的对话/Agent：先按侧边栏删除 worktree 项目的语义确认。
      const worktreeWorkspaceState = selectWorkspaceZCodeState(
        useZCodeSessionStore.getState(),
        occupancy.worktreePath,
      );
      if (hasRunningWorkspaceChat({ workspaceState: worktreeWorkspaceState, taskItems: [] })) {
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
          return { outcome: "aborted" };
        }
      }

      const removalConfirmed = await requestConfirmation({
        title: intl.formatMessage({
          id: "git.branchSwitcher.deleteConfirm.worktreeOccupiedTitle",
        }),
        description: intl.formatMessage(
          { id: "git.branchSwitcher.deleteConfirm.worktreeOccupiedDescription" },
          { branchName, path: occupancy.worktreePath },
        ),
        confirmLabel: intl.formatMessage({
          id: "git.branchSwitcher.deleteConfirm.worktreeOccupiedConfirm",
        }),
        confirmVariant: "destructive",
      });
      if (!removalConfirmed) {
        return { outcome: "aborted" };
      }

      const removed = await gitService.removeWorktree({
        workspacePath,
        worktreePath: occupancy.worktreePath,
      });
      if (!removed.ok) {
        logger.warn("[GitBranchDelete] 移除占用 worktree 被阻塞", {
          workspacePath,
          branchName,
          worktreePath: occupancy.worktreePath,
          issues: removed.issues.map((issue) => issue.code),
        });
        if (removed.issues[0]?.code === "worktree-not-found") {
          // 注册表已无此 worktree（目录与注册均被外部清理）→ 阻塞已解除，继续删分支。
          return { outcome: "ready" };
        }
        notifyWorktreeFailure(removed.issues);
        return { outcome: "aborted" };
      }

      logger.info("[GitBranchDelete] 移除占用 worktree 成功", {
        workspacePath,
        branchName,
        worktreePath: occupancy.worktreePath,
      });
      closeRemovedWorktreeTabs(occupancy.worktreePath);
      toast(
        intl.formatMessage({ id: "git.worktree.toast.removed" }, { path: occupancy.worktreePath }),
      );
      return { outcome: "ready" };
    },
    [
      closeRemovedWorktreeTabs,
      gitService,
      intl,
      notifyWorktreeFailure,
      requestConfirmation,
      workspacePath,
    ],
  );

  const deleteBranch = useCallback(
    async (branchName: string) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "git.branchSwitcher.deleteConfirm.title" }),
        description: intl.formatMessage(
          { id: "git.branchSwitcher.deleteConfirm.description" },
          { branchName },
        ),
        confirmLabel: intl.formatMessage({ id: "git.branchSwitcher.deleteConfirm.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        return;
      }

      try {
        let result = await gitService.deleteBranch({ workspacePath, branchName });
        if (!result.ok && result.issues[0]?.code === "branch-in-other-worktree") {
          const recovery = await removeOccupyingWorktree(branchName);
          if (recovery.outcome === "aborted") {
            return;
          }
          result = await gitService.deleteBranch({ workspacePath, branchName });
        }
        if (!result.ok && result.issues[0]?.code === "branch-not-fully-merged") {
          // 未合并分支不随首次确认删除：需要用户对“丢提交”二次确认后才允许 -D。
          const forceConfirmed = await requestConfirmation({
            title: intl.formatMessage({ id: "git.branchSwitcher.deleteConfirm.forceTitle" }),
            description: intl.formatMessage(
              { id: "git.branchSwitcher.deleteConfirm.forceDescription" },
              { branchName },
            ),
            confirmLabel: intl.formatMessage({
              id: "git.branchSwitcher.deleteConfirm.forceConfirm",
            }),
            confirmVariant: "destructive",
          });
          if (!forceConfirmed) {
            return;
          }
          result = await gitService.deleteBranch({ workspacePath, branchName, force: true });
        }

        if (!result.ok) {
          logger.warn("[GitBranchDelete] 删除分支被阻塞", {
            workspacePath,
            branchName,
            issues: result.issues.map((issue) => issue.code),
          });
          notifyFailure(result.issues, result.branchName ?? branchName);
          return;
        }

        const deletedBranchName = result.branchName ?? branchName;
        logger.info("[GitBranchDelete] 删除分支成功", {
          workspacePath,
          branchName: deletedBranchName,
        });
        const successMessageId = resolveGitBranchSuccessMessageId(result);
        if (successMessageId) {
          toast(intl.formatMessage({ id: successMessageId }, { branchName: deletedBranchName }));
        }
        onDeleted(deletedBranchName);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitBranchDelete] 删除分支请求失败", {
          workspacePath,
          branchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      }
    },
    [
      gitService,
      intl,
      notifyFailure,
      onDeleted,
      removeOccupyingWorktree,
      requestConfirmation,
      workspacePath,
    ],
  );

  return { deleteBranch };
}
