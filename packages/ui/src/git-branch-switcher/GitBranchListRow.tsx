import { useState } from "react";
import type { GitLocalBranch } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { CommandItem } from "@/components/ui/command.js";
import { GitBranchConversationAction } from "@/git-branch-switcher/GitBranchConversationAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import type { WorkspaceConversationPromptScope } from "@/lib/workspaceConversationPromptRuntime.js";
import { cn } from "@/components/lib/utils.js";
import { GitBranchIcon, FolderGit2, Trash2Icon } from "lucide-react";

interface GitBranchListRowProps {
  branch: GitLocalBranch;
  isCurrent: boolean;
  /** 仅当前分支行展示的未提交更改文案；其余行传 null。 */
  currentDirtyLabel: string | null;
  mutationPending: boolean;
  onSwitch: (branchName: string) => void;
  enableConversationAction: boolean;
  conversationPromptScope: WorkspaceConversationPromptScope;
  /** 先于提示词发送调用，用于关闭分支弹层。 */
  onConversationActionTriggered: () => void;
  /** hover / focus 持续 2 秒后行尾浮现「删除分支」；当前检出（主树或任意 worktree）中的分支不提供。 */
  onDeleteBranch?: (branchName: string) => void;
  /** 提供时行尾浮现「新建 Worktree」：把未被任何工作树检出的既有分支检出为独立 worktree。 */
  onCreateWorktree?: (branchName: string) => void;
  /** worktree 创建请求进行中；期间禁用行尾创建动作，避免并发创建。 */
  createWorktreePending?: boolean;
}

/**
 * 分支弹窗内的单行分支。行尾对话动作由交互状态决定挂载（hover / focus-within，
 * 触屏 hover:none 常驻），未交互时不渲染、不占行内布局——同
 * workspace-grouped-tasks/task-row 的挂载式决策，不用 CSS 隐藏。
 * 状态随行组件生命周期持有，弹层关闭即重置。
 */
export function GitBranchListRow({
  branch,
  isCurrent,
  currentDirtyLabel,
  mutationPending,
  onSwitch,
  enableConversationAction,
  conversationPromptScope,
  onConversationActionTriggered,
  onDeleteBranch,
  onCreateWorktree,
  createWorktreePending = false,
}: GitBranchListRowProps) {
  const { intl } = useZCodeIntl();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const shouldMountConversationAction =
    enableConversationAction && (isCoarseTouchDevice() || hovered || focusWithin);
  // 删除为破坏性动作，仅在交互（hover / focus）时浮现；当前检出中的分支不可删。
  const interactive = hovered || focusWithin;
  const shouldMountDeleteAction = !isCurrent && Boolean(onDeleteBranch) && interactive;
  // 已被任意工作树（主树或 linked worktree）检出的分支再建 worktree 会被 git 拒绝
  // （同一分支不能同时检出两处），只对未被检出的分支提供入口。
  const shouldMountCreateWorktreeAction =
    Boolean(onCreateWorktree) && !isCurrent && branch.worktreePath === null && interactive;

  return (
    <CommandItem
      value={branch.name}
      // 当前分支不打勾（2026-09-27 用户决策）：去掉行尾 ✓，以选中底色标识，
      // 因此不再写 data-checked（该 attr 只驱动 command.tsx 的 CheckIcon）。
      data-branch-current={isCurrent ? "true" : undefined}
      disabled={mutationPending}
      className={cn(
        "items-start gap-3 rounded-lg px-3 py-2 text-ui-base",
        "data-[branch-current=true]:bg-selected",
      )}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocusCapture={() => {
        setFocusWithin(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
      onSelect={() => {
        onSwitch(branch.name);
      }}
    >
      <GitBranchIcon className="mt-0.5 size-4 text-foreground-subtle" />
      <div className="min-w-0 flex-1 flex flex-col gap-1 text-left">
        <div
          className={cn(
            "truncate text-ui-base text-foreground",
            isCurrent ? "font-semibold" : "font-medium",
          )}
        >
          {branch.name}
        </div>
        {isCurrent && currentDirtyLabel ? (
          <p className="pt-0.5 text-ui-base text-foreground-subtle">{currentDirtyLabel}</p>
        ) : null}
      </div>
      {shouldMountConversationAction ? (
        <GitBranchConversationAction
          kind={isCurrent ? "pull" : "merge"}
          branchName={branch.name}
          scope={conversationPromptScope}
          mutationPending={mutationPending}
          onTriggered={onConversationActionTriggered}
        />
      ) : null}
      {shouldMountCreateWorktreeAction && onCreateWorktree ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={createWorktreePending}
          aria-label={intl.formatMessage(
            { id: "git.branchSwitcher.createWorktreeAction.ariaLabel" },
            { branchName: branch.name },
          )}
          className="-ml-2 -mt-0.5 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
          onClick={(event) => {
            // 阻止冒泡到 cmdk Item，避免创建动作被当作分支切换。
            event.stopPropagation();
            onCreateWorktree(branch.name);
          }}
        >
          <FolderGit2 className="size-3.5" />
        </Button>
      ) : null}
      {shouldMountDeleteAction && onDeleteBranch ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={mutationPending}
          aria-label={intl.formatMessage(
            { id: "git.branchSwitcher.deleteAction.ariaLabel" },
            { branchName: branch.name },
          )}
          className="-ml-2 -mt-0.5 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
          onClick={(event) => {
            // 阻止冒泡到 cmdk Item，避免删除动作被当作分支切换。
            event.stopPropagation();
            onDeleteBranch(branch.name);
          }}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      ) : null}
    </CommandItem>
  );
}
