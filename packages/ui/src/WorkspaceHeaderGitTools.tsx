/**
 * 工作区头部 Git 工具组（分支选择 / 同步），渲染在右上角分享按钮左侧。
 *
 * 自 v4 状态面板的「Git 工具」分区迁入（specs/workspace-header-git-tools.md）。展示规则：
 * 分支切换器是常驻入口；「同步」按钮（2026-10-14 按用户决策由互斥占槽的「提交/推送」
 * 「拉取」两入口合并）在 Git 仓库内常驻，点击与 ⇧⌘S 共用 resolveGitSyncDispatch 裁决——
 * 脏仓库或已提交未推送时打开提交/推送弹窗（弹层交互状态归 GitActionMenu），干净且有
 * 上游时改派快进拉取（--ff-only，结果用 toast 反馈、不弹确认框；分叉即报错，与分支
 * 弹窗内由 AI 处理分叉的「拉取」语义不同、互不替代）。拉取链路（pending 门控、toast、
 * IGitService）归本组件持有，经 pullFallback 注入 GitActionMenu 转发；组件不持有
 * Git 状态：summary / 变更摘要全部由 shell 投影下发，变更由 onRefreshGit 驱动刷新。
 * 「更改」入口已于 2026-09-26 按用户决策移除（Git 审阅改由其他入口进入）；2026-10-14
 * 按用户决策以「审查」按钮形态回归（FileDiffIcon，无 +N -N 统计），同日按用户决策与
 * 「同步」按钮一起去掉文案收敛为纯图标（中文标签保留在 aria-label 与 tooltip），
 * 展示条件与同步按钮的主动作同源（isDirty || canPushGitBranch），
 * 点击经壳层注入的 onOpenGitReview 打开右侧面板审查 tab。
 * 键盘快捷键：单命令 gitSync（默认 ⇧⌘S）的监听归 GitActionMenu 所有，可用性与
 * 「同步」按钮展示规则同源，键位可在设置-键盘快捷键改绑。
 */
import { useCallback, useState } from "react";
import { FileDiffIcon } from "lucide-react";
import type { GitRepositorySummary, ZCodeTaskChangeSummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { canPushGitBranch } from "@/git-action-menu/display.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

interface WorkspaceHeaderGitToolsProps {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  onRefreshGit: () => void;
  /**
   * 打开右侧面板审查 tab（GitPane），由壳层注入 handleOpenGitReview；
   * 缺省时按钮置灰（沿用 2026-09-26 移除前「更改」入口的失败语义）。
   */
  onOpenGitReview?: () => void;
}

export function WorkspaceHeaderGitTools({
  workspaceAbsPath,
  workspaceIdentity,
  gitSummary,
  gitDirtyFileCount,
  activeTaskChangeSummary = null,
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
  // 2026-10-14 统一「同步」按钮后的裁决输入：本地有待提交/待推送时主动作（提交/推送
  // 弹窗）优先；仓库干净且有上游时改派快进拉取。detached HEAD / 无上游时拉取不可用，
  // 无上游的新分支已由 canPushGitBranch 划入主动作（首次推送建上游）。
  const primaryActionAvailable = gitSummary.isDirty || canPushGitBranch(gitSummary);
  const pullAvailable = !primaryActionAvailable && Boolean(gitSummary.trackingBranchName);
  // 钩子必须全部位于条件返回之前；gitSummary 就绪与否只影响 JSX，不影响钩子数量。
  if (!gitSummary.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  // 审查入口的展示条件：未暂存/已暂存（isDirty）或已提交未推送（canPushGitBranch）。
  const reviewVisible = primaryActionAvailable;
  const reviewLabel = intl.formatMessage({ id: "sidePane.review" });

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {/* 2026-09-26 按用户决策调整排序：分支切换器在最左（常驻项），Git 操作入口在其右。 */}
      <GitBranchSwitcher
        workspacePath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        gitSummary={gitSummary}
        dirtyFileCount={gitDirtyFileCount}
        onRefreshGit={onRefreshGit}
        markAsWorkspaceHeaderBranch
        enableConversationActions
        className="min-w-0 px-0 pt-0"
        triggerClassName="h-7 w-fit min-w-0 gap-1 rounded-lg px-1.5 text-ui-sm text-foreground hover:bg-hover hover:text-foreground [&>span]:max-w-20"
        popoverSide="bottom"
        popoverClassName="w-72"
        branchListClassName="max-h-56"
        showFooterActions
      />
      <GitActionMenu
        workspacePath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        gitSummary={gitSummary}
        activeTaskChangeSummary={activeTaskChangeSummary}
        onRefreshGit={onRefreshGit}
        pullFallback={{
          available: pullAvailable,
          pending: pullPending,
          onTrigger: handlePull,
        }}
      />
      {/* 2026-10-14 按用户决策新增审查快捷入口（2026-09-26 移除的「更改」入口回归，
          不再携带 +N -N 统计）：工作区有未暂存/已暂存/已提交未推送内容时展示，
          点击打开右侧面板审查 tab；条件与同步按钮的主动作同源（isDirty || canPushGitBranch）。
          形态与「同步」按钮同档：无边框 ghost 纯图标（2026-10-14 按用户决策去掉文案），
          与终端/浏览器等头部图标按钮共用 icon-md 规范。 */}
      {reviewVisible ? (
        <ControlHintTooltip title={reviewLabel} side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            disabled={!onOpenGitReview}
            aria-label={reviewLabel}
            className="[app-region:no-drag]"
            onClick={() => onOpenGitReview?.()}
          >
            <FileDiffIcon className="text-foreground" aria-hidden />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </div>
  );
}
