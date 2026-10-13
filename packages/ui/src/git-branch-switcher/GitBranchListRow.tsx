import { useState } from "react";
import type { GitLocalBranch } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { CommandItem } from "@/components/ui/command.js";
import { GitBranchConversationAction } from "@/git-branch-switcher/GitBranchConversationAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import type { WorkspaceConversationPromptScope } from "@/lib/workspaceConversationPromptRuntime.js";
import { cn } from "@/components/lib/utils.js";
import {
  useSustainedHover,
  DELETE_REVEAL_DELAY_MS,
} from "@/git-branch-switcher/useSustainedHover.js";
import { FolderGit2, GitBranchIcon, Trash2Icon } from "lucide-react";

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
  /** 行尾「检出为 Worktree」动作：非当前分支直接检出；已有 worktree 或当前分支走并行副本语义。 */
  onCheckoutAsWorktree?: (branchName: string) => void;
  /** hover / focus 持续 2 秒后行尾浮现「删除分支」；当前检出（主树或任意 worktree）中的分支不提供。 */
  onDeleteBranch?: (branchName: string) => void;
  /** 该分支正被某个 worktree 检出：属于“工作中”，隐藏删除入口（先移除 worktree 才能删分支）。 */
  checkedOutInWorktree?: boolean;
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
  onCheckoutAsWorktree,
  onDeleteBranch,
  checkedOutInWorktree = false,
}: GitBranchListRowProps) {
  const { intl } = useZCodeIntl();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const shouldMountConversationAction =
    enableConversationAction && (isCoarseTouchDevice() || hovered || focusWithin);
  // 所有分支行（含当前分支）都提供 worktree 动作：当前分支在该动作下走“并行副本”语义。
  const shouldMountWorktreeAction =
    Boolean(onCheckoutAsWorktree) && (isCoarseTouchDevice() || hovered || focusWithin);
  // 删除是破坏性动作：hover / focus 持续 2 秒才浮现（触屏无 hover 立即显示）；当前分支不可删。
  const interactive = hovered || focusWithin;
  const deleteRevealed = useSustainedHover(
    interactive,
    isCoarseTouchDevice() ? 0 : DELETE_REVEAL_DELAY_MS,
  );
  const shouldMountDeleteAction =
    !isCurrent && !checkedOutInWorktree && Boolean(onDeleteBranch) && interactive && deleteRevealed;

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
      {shouldMountWorktreeAction && onCheckoutAsWorktree ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={mutationPending}
          aria-label={intl.formatMessage(
            { id: "git.worktree.checkoutAction.ariaLabel" },
            { branchName: branch.name },
          )}
          title={intl.formatMessage({ id: "git.worktree.checkoutAction" })}
          className="-mt-0.5 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
          onClick={(event) => {
            // 阻止冒泡到 cmdk Item，避免行内动作被当作分支切换。
            event.stopPropagation();
            onCheckoutAsWorktree(branch.name);
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
          className="-mt-0.5 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
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
