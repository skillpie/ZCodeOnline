import { useCallback, useEffect, useState } from "react";
import type {
  GitWorktreeListResult,
  GitWorktreeMutationIssue,
  GitWorktreeMutationResult,
  GitWorktreeRecord,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** worktree 变更 issue code → toast 文案 id；与分支 issue 同码的沿用分支文案。 */
function resolveGitWorktreeIssueMessageId(issue: GitWorktreeMutationIssue): string | null {
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
    default:
      return null;
  }
}

interface UseGitWorktreeActionsOptions {
  workspacePath: string;
  /** 下拉弹层展开态；展开时与分支列表同一节奏重拉 worktree 投影。 */
  open: boolean;
}

/**
 * 分支切换器的 worktree 动作：列表投影、检出为 worktree、打开、移除。
 * git 本身是唯一事实（worktree 元数据），这里只维护投影缓存，不持久化、不广播；
 * 列表随下拉展开重新拉取，终端里的增删会在下一次展开时回灌。
 */
export function useGitWorktreeActions({ workspacePath, open }: UseGitWorktreeActionsOptions) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const tabStoreApi = useTabStoreApi();
  const requestConfirmation = useConfirmDialog();
  const [worktreesResult, setWorktreesResult] = useState<GitWorktreeListResult | null>(null);
  const [worktreePending, setWorktreePending] = useState(false);

  const loadWorktrees = useCallback(async () => {
    // worktree 分组是附属能力：读取失败静默降级为不展示，不与分支列表共用失败 toast。
    try {
      const nextResult = await gitService.listWorktrees({ workspacePath });
      setWorktreesResult(nextResult);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitWorktreeActions] 读取 worktree 列表失败", {
        workspacePath,
        error: message,
      });
      setWorktreesResult(null);
    }
  }, [gitService, workspacePath]);

  useEffect(() => {
    setWorktreesResult(null);
  }, [workspacePath]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // 与分支列表同一节奏：每次展开都重新读取，git 是唯一事实，终端里的增删也能回灌。
    void loadWorktrees();
  }, [loadWorktrees, open]);

  const notifyWorktreeFailure = useCallback(
    (result: GitWorktreeMutationResult) => {
      const issue = result.issues[0];
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

  const openWorktreeTab = useCallback(
    (worktreePath: string) => {
      // 与 useRootWorkspaceActions 打开本地目录一致：addTab 命中已打开 tab 时激活它；
      // startDraft 表达 workspace-only 意图，回到空草稿并清掉该 workspace 的 activeTaskId。
      tabStoreApi.getState().addTab(worktreePath);
      useZCodeSessionStore.getState().startDraft(worktreePath);
    },
    [tabStoreApi],
  );

  const checkoutBranchAsWorktree = useCallback(
    async (branchName: string) => {
      setWorktreePending(true);

      try {
        const result = await gitService.addWorktree({ workspacePath, branchName });
        if (!result.ok || !result.worktree) {
          logger.warn("[GitWorktreeActions] 检出 worktree 被阻塞", {
            workspacePath,
            branchName,
            issues: result.issues.map((issue) => issue.code),
          });
          notifyWorktreeFailure(result);
          return;
        }

        logger.info("[GitWorktreeActions] 检出 worktree 成功", {
          workspacePath,
          branchName,
          worktreePath: result.worktree.path,
        });
        toast(
          intl.formatMessage({ id: "git.worktree.toast.created" }, { path: result.worktree.path }),
        );
        openWorktreeTab(result.worktree.path);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitWorktreeActions] 检出 worktree 请求失败", {
          workspacePath,
          branchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        setWorktreePending(false);
      }
    },
    [gitService, intl, notifyWorktreeFailure, openWorktreeTab, workspacePath],
  );

  const removeWorktree = useCallback(
    async (worktree: GitWorktreeRecord) => {
      if (worktree.isCurrentWorkspace) {
        // 当前行不渲染移除入口，这里兜底防御：移除自己所在的 workspace 没有意义且危险。
        return;
      }

      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "git.worktree.removeConfirm.title" }),
        description: intl.formatMessage(
          { id: "git.worktree.removeConfirm.description" },
          { path: worktree.path },
        ),
        confirmLabel: intl.formatMessage({ id: "git.worktree.removeConfirm.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        return;
      }

      // renderer 侧防护：目标 worktree 还有运行中任务时先阻止，避免删掉运行中会话的 cwd。
      // 任务缓存只覆盖 UI 已加载过的 workspace，属于尽力防护；Host 侧 dirty 校验仍会兜底。
      const hasRunningTask = Object.values(
        useTaskQueryCacheStore.getState().taskMetaByEntityKey,
      ).some((item) => item.workspacePath === worktree.path && item.status === "running");
      if (hasRunningTask) {
        toast(intl.formatMessage({ id: "git.worktree.toast.runningTaskBlocked" }));
        return;
      }

      setWorktreePending(true);

      try {
        const result = await gitService.removeWorktree({
          workspacePath,
          worktreePath: worktree.path,
        });
        if (!result.ok) {
          logger.warn("[GitWorktreeActions] 移除 worktree 被阻塞", {
            workspacePath,
            worktreePath: worktree.path,
            issues: result.issues.map((issue) => issue.code),
          });
          notifyWorktreeFailure(result);
          return;
        }

        logger.info("[GitWorktreeActions] 移除 worktree 成功", {
          workspacePath,
          worktreePath: worktree.path,
        });
        toast(intl.formatMessage({ id: "git.worktree.toast.removed" }, { path: worktree.path }));
        await loadWorktrees();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitWorktreeActions] 移除 worktree 请求失败", {
          workspacePath,
          worktreePath: worktree.path,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        setWorktreePending(false);
      }
    },
    [gitService, intl, loadWorktrees, notifyWorktreeFailure, requestConfirmation, workspacePath],
  );

  return {
    worktreesResult,
    worktreePending,
    loadWorktrees,
    openWorktreeTab,
    checkoutBranchAsWorktree,
    removeWorktree,
  };
}
