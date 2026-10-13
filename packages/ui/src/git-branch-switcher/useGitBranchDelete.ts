import { useCallback } from "react";
import { toast } from "@/components/ui/toast.js";
import {
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
} from "@/git-branch-switcher/display.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

interface UseGitBranchDeleteOptions {
  workspacePath: string;
  /** 删除成功后从分支投影移除该分支（分支投影由调用方持有）。 */
  onDeleted: (branchName: string) => void;
}

/**
 * 分支行「删除分支」流程：确认弹窗 → 安全删（git branch -d，仅删已合并分支）→
 * git 拒绝未合并时二次确认“强制删除将丢提交” → 携带 force 重试（-D）。
 * 破坏性动作配 2 秒悬停浮现（GitBranchListRow）+ 确认弹窗双保险。
 */
export function useGitBranchDelete({ workspacePath, onDeleted }: UseGitBranchDeleteOptions) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();

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
    [gitService, intl, notifyFailure, onDeleted, requestConfirmation, workspacePath],
  );

  return { deleteBranch };
}
