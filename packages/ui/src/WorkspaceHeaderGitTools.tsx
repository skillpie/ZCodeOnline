/**
 * 工作区头部 Git 工具组（更改 / 提交 / 拉取 / 分支选择），渲染在右上角分享按钮左侧。
 *
 * 自 v4 状态面板的「Git 工具」分区迁入（specs/workspace-header-git-tools.md）。展示规则：
 * 分支切换器是常驻入口；「更改」只承载未提交内容；「提交」在脏仓库或已提交未推送时
 * 展示；工作区干净且无待推送时同一位置换成「拉取」，避免一排不可用的置灰按钮占着头部。
 * 组件不持有 Git 状态：summary / 行数统计 / 变更摘要全部由 shell 投影下发，
 * 变更由 onRefreshGit 驱动刷新；提交与分支弹层的交互状态归 GitActionMenu /
 * GitBranchSwitcher 内部所有，这里只提供触发器。拉取是本组件唯一的即时动作：
 * 走 IGitService.pull（快进式），结果用 toast 反馈，不弹确认框。
 */
import { useCallback, useState } from "react";
import { ArrowDownToLine, FileDiffIcon, LoaderIcon } from "lucide-react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { canPushGitBranch } from "@/git-action-menu/display.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { cn } from "@/components/lib/utils.js";

interface WorkspaceHeaderGitToolsProps {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  /** worktree 行级变更统计（状态面板时代同一来源），驱动 `+N -N` 展示。 */
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  onRefreshGit: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
}

export function WorkspaceHeaderGitTools({
  workspaceAbsPath,
  workspaceIdentity,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeChangeSummary = null,
  activeTaskChangeSummary = null,
  gitWorktreeReviewSourceId,
  onRefreshGit,
  onOpenGitReview,
}: WorkspaceHeaderGitToolsProps) {
  const { intl } = useZCodeIntl();
  const { gitService } = useServices();
  const [pullPending, setPullPending] = useState(false);
  const handlePull = useCallback(() => {
    if (pullPending) {
      return;
    }
    setPullPending(true);
    void gitService
      .pull({ workspacePath: workspaceAbsPath })
      .then(() => {
        toast(intl.formatMessage({ id: "git.pull.toast.success" }));
        onRefreshGit();
      })
      .catch((error: unknown) => {
        toast(
          intl.formatMessage({ id: "git.pull.toast.error" }, { error: getErrorMessage(error) }),
        );
      })
      .finally(() => {
        setPullPending(false);
      });
  }, [gitService, intl, onRefreshGit, pullPending, workspaceAbsPath]);
  // 钩子必须全部位于上面的条件返回之前；gitSummary 就绪与否只影响 JSX，不影响钩子数量。
  if (!gitSummary.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  const hasChanges = added + removed > 0;
  // 「更改」只承载未提交内容的审阅；「提交」在脏仓库或已提交未推送
  // （canPushGitBranch：领先上游 / 尚无上游的新分支）时展示——后者点击时
  // GitActionMenu 的主动作裁决会直接进推送弹窗。两者都不在（干净且同步中）
  // 时，同一位置换成「拉取」，提供快速同步远程的入口；分支切换器保持常驻。
  const showChangesEntry = gitSummary.isDirty;
  const showCommitEntry = gitSummary.isDirty || canPushGitBranch(gitSummary);
  // pull 需要上游分支；detached HEAD / 无上游时 canPushGitBranch 分支已接管该槽位。
  const showPullEntry = !showCommitEntry && Boolean(gitSummary.trackingBranchName);
  const changesLabel = intl.formatMessage({ id: "chat.statusPanel.changes" });
  const pullLabel = intl.formatMessage({ id: "git.pull.action" });
  const canOpenReview = Boolean(onOpenGitReview);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {showChangesEntry ? (
        <ControlHintTooltip title={changesLabel} side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={!canOpenReview}
            data-testid="workspace-header-git-changes"
            aria-label={changesLabel}
            className="h-7 w-fit gap-1 rounded-lg px-1.5 [app-region:no-drag]"
            onClick={() => {
              onOpenGitReview?.(gitWorktreeReviewSourceId ?? undefined);
            }}
          >
            <FileDiffIcon className="size-4 shrink-0 text-foreground" aria-hidden />
            {/* 与「拉取」文字同构：纯 inline 排版走按钮的同一行盒垂直居中。
                mono 数字字形在其行盒里天然偏高，加 1px 光学下移校正。 */}
            <span className="relative top-px hidden min-w-0 whitespace-nowrap font-mono text-ui-sm tabular-nums @min-[560px]/workspace-header:inline">
              <span className={cn("text-diff-added", !hasChanges && "opacity-50")}>+{added}</span>{" "}
              <span className={cn("text-diff-removed", !hasChanges && "opacity-50")}>
                -{removed}
              </span>
            </span>
          </Button>
        </ControlHintTooltip>
      ) : null}
      {showCommitEntry ? (
        <GitActionMenu
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          gitSummary={gitSummary}
          activeTaskChangeSummary={activeTaskChangeSummary}
          onRefreshGit={onRefreshGit}
        />
      ) : null}
      {showPullEntry ? (
        <ControlHintTooltip title={pullLabel} side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={pullPending}
            data-testid="workspace-header-git-pull"
            aria-label={pullLabel}
            className="h-7 w-fit gap-1 rounded-lg px-1.5 [app-region:no-drag]"
            onClick={handlePull}
          >
            {pullPending ? (
              <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground" aria-hidden />
            ) : (
              <ArrowDownToLine className="size-4 shrink-0 text-foreground" aria-hidden />
            )}
            <span className="min-w-0 whitespace-nowrap text-ui-sm text-foreground">
              {pullLabel}
            </span>
          </Button>
        </ControlHintTooltip>
      ) : null}
      <GitBranchSwitcher
        workspacePath={workspaceAbsPath}
        gitSummary={gitSummary}
        dirtyFileCount={gitDirtyFileCount}
        onRefreshGit={onRefreshGit}
        markAsWorkspaceHeaderBranch
        className="min-w-0 px-0 pt-0"
        triggerClassName="h-7 w-fit min-w-0 gap-1 rounded-lg px-1.5 text-ui-sm text-foreground hover:bg-hover hover:text-foreground [&>span]:max-w-20"
        popoverSide="bottom"
        popoverClassName="w-72"
        branchListClassName="max-h-56"
        showFooterActions
      />
    </div>
  );
}
