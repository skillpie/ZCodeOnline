import { useCallback, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { resolveGitWorktreeIssueMessageId } from "@/git-branch-switcher/display.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { buildWorktreeProjectName } from "@/lib/worktreeProjectName.js";
import { logger } from "@/logger.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { GitWorktreeMutationIssue } from "@zcode/shared";

interface UseGitWorktreeActionsOptions {
  workspacePath: string;
}

/**
 * 分支切换器 footer 的「新建 Worktree」：在主树 `.worktrees/` 下创建
 * 目录 `{工程名}-{6位随机数}` 与分支 `feat/{同6位随机数}`，并作为独立项目打开。
 * worktree 在模型上是独立项目，不属于分支维度；分支切换器只保留这一个创建入口。
 * 「新建 Worktree」之外的创建入口是分支行的行尾动作：把一个未被任何工作树
 * 检出的既有分支检出为新 worktree（见 createWorktreeForBranch）。
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

  /** 两种创建模式的共同后置处理：失败 toast、成功 toast 并作为独立项目打开新 worktree。 */
  const settleAddWorktreeResult = useCallback(
    async (
      result: Awaited<ReturnType<typeof gitService.addWorktree>>,
      context: { branchName: string; directoryName: string },
    ): Promise<boolean> => {
      if (!result.ok || !result.worktree) {
        logger.warn("[GitWorktreeActions] 创建 worktree 被阻塞", {
          workspacePath,
          branchName: context.branchName,
          directoryName: context.directoryName,
          issues: result.issues.map((issue) => issue.code),
        });
        notifyWorktreeFailure(result.issues, context.branchName);
        return false;
      }

      logger.info("[GitWorktreeActions] 创建 worktree 成功", {
        workspacePath,
        branchName: context.branchName,
        directoryName: context.directoryName,
        worktreePath: result.worktree.path,
      });
      toast(
        intl.formatMessage({ id: "git.worktree.toast.created" }, { path: result.worktree.path }),
      );
      openWorktreeTab(result.worktree.path);
      return true;
    },
    [intl, notifyWorktreeFailure, openWorktreeTab, workspacePath],
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
      await settleAddWorktreeResult(result, {
        branchName: plan.branchName,
        directoryName: plan.directoryName,
      });
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
  }, [gitService, intl, settleAddWorktreeResult, workspacePath]);

  /** 分支行尾动作：把未被任何工作树检出的既有分支检出为独立 worktree。 */
  const createWorktreeForBranch = useCallback(
    async (branchName: string) => {
      setWorktreePending(true);

      try {
        // 检出既有分支模式不传 directoryName，由服务端按「目录名 = 净化分支名」约定派生，
        // 与 worktree 重命名的命名规则保持一致。
        const result = await gitService.addWorktree({ workspacePath, branchName });
        await settleAddWorktreeResult(result, {
          branchName,
          directoryName: branchName,
        });
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitWorktreeActions] 创建 worktree 请求失败", {
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
    [gitService, intl, settleAddWorktreeResult, workspacePath],
  );

  return {
    worktreePending,
    createWorktreeForProject,
    createWorktreeForBranch,
  };
}
