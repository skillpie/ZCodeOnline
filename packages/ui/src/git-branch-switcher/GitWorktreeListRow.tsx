import { useState } from "react";
import type { GitWorktreeRecord } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { CommandItem } from "@/components/ui/command.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FolderGit2, SquarePenIcon, Trash2Icon } from "lucide-react";

interface GitWorktreeListRowProps {
  worktree: GitWorktreeRecord;
  mutationPending: boolean;
  onOpen: (worktreePath: string) => void;
  onRename: (worktree: GitWorktreeRecord) => void;
  onRemove: (worktree: GitWorktreeRecord) => void;
}

function labelFromWorktreePath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * worktree 单行。点击行 = 在本窗口打开该 worktree 标签页；
 * 行尾重命名 / 移除动作与分支行对话动作同模式（hover / focus-within 挂载，触屏常驻）。
 * 当前行不提供重命名与移除（动到正打开的 workspace 危险），行内以「当前」标识替代。
 * detached worktree 没有分支可改，重命名入口隐藏。
 * 行名优先展示当前检出的分支名（随 worktree 内切分支实时变化），detached / 旧数据回退目录名，
 * 平铺列表里一眼可见每个 worktree 现在在哪个分支上。
 */
export function GitWorktreeListRow({
  worktree,
  mutationPending,
  onOpen,
  onRename,
  onRemove,
}: GitWorktreeListRowProps) {
  const { intl } = useZCodeIntl();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const canMutate = !worktree.isCurrentWorkspace;
  // 重命名 / 移除仅在交互（hover / focus）时浮现。
  const interactive = hovered || focusWithin;
  const shouldMountMutateActions = canMutate && interactive;
  const canRename = canMutate && Boolean(worktree.branchName);
  const shouldMountRemoveAction = shouldMountMutateActions;

  return (
    <CommandItem
      value={worktree.branchName ?? labelFromWorktreePath(worktree.path)}
      disabled={mutationPending}
      title={worktree.path}
      className="items-center gap-3 rounded-lg px-3 py-2 text-ui-base"
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
        onOpen(worktree.path);
      }}
    >
      <FolderGit2 className="size-4 shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1 truncate text-left text-ui-base font-medium text-foreground">
        {worktree.branchName ?? labelFromWorktreePath(worktree.path)}
      </span>
      {worktree.isCurrentWorkspace ? (
        <span className="shrink-0 text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "git.worktree.current" })}
        </span>
      ) : null}
      {shouldMountMutateActions && canRename ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={mutationPending}
          aria-label={intl.formatMessage(
            { id: "git.worktree.renameAction.ariaLabel" },
            { name: worktree.branchName ?? labelFromWorktreePath(worktree.path) },
          )}
          className="-ml-2 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
          onClick={(event) => {
            // 阻止冒泡到 cmdk Item，避免行内动作被当作“打开 worktree”。
            event.stopPropagation();
            onRename(worktree);
          }}
        >
          <SquarePenIcon className="size-3.5" />
        </Button>
      ) : null}
      {shouldMountRemoveAction ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={mutationPending}
          aria-label={intl.formatMessage(
            { id: "git.worktree.removeAction.ariaLabel" },
            { name: worktree.branchName ?? labelFromWorktreePath(worktree.path) },
          )}
          className="-ml-2 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
          onClick={(event) => {
            // 阻止冒泡到 cmdk Item，避免移除动作被当作“打开 worktree”。
            event.stopPropagation();
            onRemove(worktree);
          }}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      ) : null}
    </CommandItem>
  );
}
