import { useState } from "react";
import type { GitWorktreeRecord } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { CommandItem } from "@/components/ui/command.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { FolderGit2, Trash2Icon } from "lucide-react";

interface GitWorktreeListRowProps {
  worktree: GitWorktreeRecord;
  mutationPending: boolean;
  onOpen: (worktreePath: string) => void;
  onRemove: (worktree: GitWorktreeRecord) => void;
}

function labelFromWorktreePath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * worktree 分组的单行。点击行 = 在本窗口打开该 worktree 标签页；
 * 行尾移除动作与分支行对话动作同模式（hover / focus-within 挂载，触屏常驻），
 * 当前行以「当前」标识替代移除入口——移除自己所在的 workspace 危险且无意义。
 */
export function GitWorktreeListRow({
  worktree,
  mutationPending,
  onOpen,
  onRemove,
}: GitWorktreeListRowProps) {
  const { intl } = useZCodeIntl();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const shouldMountRemoveAction =
    !worktree.isCurrentWorkspace && (isCoarseTouchDevice() || hovered || focusWithin);

  return (
    <CommandItem
      value={labelFromWorktreePath(worktree.path)}
      disabled={mutationPending}
      className="items-start gap-3 rounded-lg px-3 py-2 text-ui-base"
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
      <FolderGit2 className="mt-0.5 size-4 text-foreground-subtle" />
      <div className="min-w-0 flex-1 flex flex-col gap-1 text-left">
        <div className="truncate text-ui-base font-medium text-foreground">
          {labelFromWorktreePath(worktree.path)}
        </div>
        <p className="truncate text-ui-base text-foreground-subtle">
          {worktree.branchName ?? worktree.path}
        </p>
      </div>
      {worktree.isCurrentWorkspace ? (
        <span className="shrink-0 self-center text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "git.worktree.current" })}
        </span>
      ) : null}
      {shouldMountRemoveAction ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={mutationPending}
          aria-label={intl.formatMessage(
            { id: "git.worktree.removeAction.ariaLabel" },
            { name: labelFromWorktreePath(worktree.path) },
          )}
          className="-mt-0.5 shrink-0 rounded-sm text-foreground-subtle hover:text-foreground"
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
