import { useCallback, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { buildWorktreeProjectName } from "@/lib/worktreeProjectName.js";
import { logger } from "@/logger.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { GitWorktreeMutationIssue } from "@zcode/shared";

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
    case "worktree-detached":
      return "git.worktree.error.detached";
    default:
      return null;
  }
}

interface UseGitWorktreeActionsOptions {
  workspacePath: string;
}

/**
 * 分支切换器 footer 的「新建 Worktree」：在主树 `.worktrees/` 下创建
 * 目录 `{工程名}-{6位随机数}` 与分支 `feat/{同6位随机数}`，并作为独立项目打开。
 * worktree 在模型上是独立项目，不属于分支维度；分支切换器只保留这一个创建入口。
 */
export function useGitWorktreeActions({ workspacePath }: UseGitWorktreeActionsOptions) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const tabStoreApi = useTabStoreApi();
  const [worktreePending, setWorktreePending] = useState(false);

  const notifyWorktreeFailure = useCallback(
    (issues: GitWorktreeMutationIssue[], fallbackName: string) => {
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

  const openWorktreeTab = useCallback(
    (worktreePath: string) => {
      // 与 useRootWorkspaceActions 打开本地目录一致：addTab 命中已打开 tab 时激活它；
      // startDraft 表达 workspace-only 意图，回到空草稿并清掉该 workspace 的 activeTaskId。
      tabStoreApi.getState().addTab(worktreePath);
      useZCodeSessionStore.getState().startDraft(worktreePath);
    },
    [tabStoreApi],
  );

  const createWorktreeForProject = useCallback(async () => {
    setWorktreePending(true);

    try {
      // 分支名撞已有分支时重摇；目录名与分支名共用同一个 6 位随机后缀。
      const branches = await gitService.getLocalBranches({ workspacePath });
      const existingBranchNames = new Set(branches.branches.map((branch) => branch.name));
      const plan = buildWorktreeProjectName(workspacePath, existingBranchNames);
      const result = await gitService.addWorktree({
        workspacePath,
        newBranchName: plan.branchName,
        directoryName: plan.directoryName,
      });
      if (!result.ok || !result.worktree) {
        logger.warn("[GitWorktreeActions] 创建 worktree 被阻塞", {
          workspacePath,
          branchName: plan.branchName,
          directoryName: plan.directoryName,
          issues: result.issues.map((issue) => issue.code),
        });
        notifyWorktreeFailure(result.issues, plan.branchName);
        return;
      }

      logger.info("[GitWorktreeActions] 创建 worktree 成功", {
        workspacePath,
        branchName: plan.branchName,
        directoryName: plan.directoryName,
        worktreePath: result.worktree.path,
      });
      toast(
        intl.formatMessage({ id: "git.worktree.toast.created" }, { path: result.worktree.path }),
      );
      openWorktreeTab(result.worktree.path);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitWorktreeActions] 创建 worktree 请求失败", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setWorktreePending(false);
    }
  }, [gitService, intl, notifyWorktreeFailure, openWorktreeTab, workspacePath]);

  return {
    worktreePending,
    createWorktreeForProject,
  };
}
