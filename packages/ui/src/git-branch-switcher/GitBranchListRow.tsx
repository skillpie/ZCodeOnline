import { useState } from "react";
import type { GitLocalBranch } from "@zcode/shared";
import { CommandItem } from "@/components/ui/command.js";
import { GitBranchConversationAction } from "@/git-branch-switcher/GitBranchConversationAction.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import type { WorkspaceConversationPromptScope } from "@/lib/workspaceConversationPromptRuntime.js";
import { cn } from "@/components/lib/utils.js";
import { GitBranchIcon } from "lucide-react";

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
}: GitBranchListRowProps) {
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const shouldMountConversationAction =
    enableConversationAction && (isCoarseTouchDevice() || hovered || focusWithin);

  return (
    <CommandItem
      value={branch.name}
      data-checked={isCurrent ? "true" : undefined}
      data-branch-current={isCurrent ? "true" : undefined}
      disabled={mutationPending}
      className={cn("items-start gap-3 rounded-lg px-3 py-2 text-ui-base")}
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
        <div className="truncate text-ui-base font-medium text-foreground">{branch.name}</div>
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
    </CommandItem>
  );
}
