import type { GitWorktreeRecord } from "@zcode/shared";
import { CommandGroup } from "@/components/ui/command.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GitWorktreeListRow } from "@/git-branch-switcher/GitWorktreeListRow.js";

interface GitWorktreeSectionProps {
  worktrees: GitWorktreeRecord[];
  mutationPending: boolean;
  onOpen: (worktreePath: string) => void;
  onRename: (worktree: GitWorktreeRecord) => void;
  onRemove: (worktree: GitWorktreeRecord) => void;
}

/** 分支切换器下拉里的「Worktrees」分组；列表为空时整体不渲染。 */
export function GitWorktreeSection({
  worktrees,
  mutationPending,
  onOpen,
  onRename,
  onRemove,
}: GitWorktreeSectionProps) {
  const { intl } = useZCodeIntl();

  if (worktrees.length === 0) {
    return null;
  }

  return (
    <CommandGroup
      heading={intl.formatMessage({
        id: "git.branchSwitcher.section.worktrees",
      })}
      className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
    >
      {worktrees.map((worktree) => (
        <GitWorktreeListRow
          key={worktree.path}
          worktree={worktree}
          mutationPending={mutationPending}
          onOpen={onOpen}
          onRename={onRename}
          onRemove={onRemove}
        />
      ))}
    </CommandGroup>
  );
}
