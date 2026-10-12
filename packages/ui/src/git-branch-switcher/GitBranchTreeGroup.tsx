import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { GitLocalBranch, GitWorktreeRecord } from "@zcode/shared";
import { CommandGroup } from "@/components/ui/command.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceConversationPromptScope } from "@/lib/workspaceConversationPromptRuntime.js";
import { GitBranchListRow } from "@/git-branch-switcher/GitBranchListRow.js";
import { GitWorktreeListRow } from "@/git-branch-switcher/GitWorktreeListRow.js";
import { GitWorktreeSection } from "@/git-branch-switcher/GitWorktreeSection.js";

interface GitBranchTreeGroupProps {
  branches: GitLocalBranch[];
  displayedCurrentBranchName: string | null;
  currentDirtyLabel: string | null;
  mutationPending: boolean;
  /** 全量 linked worktree 投影；组件内部按检出分支归组为树形子项。 */
  worktrees: GitWorktreeRecord[];
  onSwitch: (branchName: string) => void;
  enableConversationAction: boolean;
  conversationPromptScope: WorkspaceConversationPromptScope;
  /** 对话动作发送前关闭弹层用。 */
  onClosePopover: () => void;
  onCheckoutAsWorktree: (branchName: string) => void;
  onOpenWorktree: (worktreePath: string) => void;
  onRenameWorktree: (worktree: GitWorktreeRecord) => void;
  onRemoveWorktree: (worktree: GitWorktreeRecord) => void;
}

/**
 * 「分支」分组 + 树形 worktree 二级菜单：有 worktree 的分支行首提供展开箭头（默认折叠），
 * 子项单行缩进展示；detached / 分支已删除等无主 worktree 落到兜底「Worktrees」分组。
 */
export function GitBranchTreeGroup({
  branches,
  displayedCurrentBranchName,
  currentDirtyLabel,
  mutationPending,
  worktrees,
  onSwitch,
  enableConversationAction,
  conversationPromptScope,
  onClosePopover,
  onCheckoutAsWorktree,
  onOpenWorktree,
  onRenameWorktree,
  onRemoveWorktree,
}: GitBranchTreeGroupProps) {
  const { intl } = useZCodeIntl();
  const [expandedWorktreeBranches, setExpandedWorktreeBranches] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleWorktreeExpanded = useCallback((branchName: string) => {
    setExpandedWorktreeBranches((current) => {
      const next = new Set(current);
      if (next.has(branchName)) {
        next.delete(branchName);
      } else {
        next.add(branchName);
      }
      return next;
    });
  }, []);

  const worktreesByBranchName = useMemo(() => {
    const map = new Map<string, GitWorktreeRecord[]>();
    for (const worktree of worktrees) {
      if (!worktree.branchName) {
        continue;
      }
      const group = map.get(worktree.branchName);
      if (group) {
        group.push(worktree);
      } else {
        map.set(worktree.branchName, [worktree]);
      }
    }
    return map;
  }, [worktrees]);

  const orphanWorktrees = useMemo(() => {
    const branchNames = new Set(branches.map((branch) => branch.name));
    return worktrees.filter(
      (worktree) => !worktree.branchName || !branchNames.has(worktree.branchName),
    );
  }, [branches, worktrees]);

  const renderBranchRows = (branch: GitLocalBranch): ReactNode[] => {
    const branchWorktrees = worktreesByBranchName.get(branch.name) ?? [];
    const worktreesExpanded = expandedWorktreeBranches.has(branch.name);
    const rows: ReactNode[] = [
      <GitBranchListRow
        key={branch.name}
        branch={branch}
        isCurrent={branch.name === displayedCurrentBranchName}
        currentDirtyLabel={currentDirtyLabel}
        mutationPending={mutationPending}
        onSwitch={onSwitch}
        enableConversationAction={enableConversationAction}
        conversationPromptScope={conversationPromptScope}
        onConversationActionTriggered={onClosePopover}
        onCheckoutAsWorktree={onCheckoutAsWorktree}
        worktreeCount={branchWorktrees.length}
        expanded={worktreesExpanded}
        onToggleWorktrees={() => {
          toggleWorktreeExpanded(branch.name);
        }}
      />,
    ];
    if (worktreesExpanded) {
      for (const worktree of branchWorktrees) {
        rows.push(
          <GitWorktreeListRow
            key={worktree.path}
            worktree={worktree}
            nested
            mutationPending={mutationPending}
            onOpen={onOpenWorktree}
            onRename={onRenameWorktree}
            onRemove={onRemoveWorktree}
          />,
        );
      }
    }
    return rows;
  };

  return (
    <>
      <CommandGroup
        heading={intl.formatMessage({
          id: "git.branchSwitcher.section.branches",
        })}
        className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
      >
        {branches.flatMap(renderBranchRows)}
      </CommandGroup>
      <GitWorktreeSection
        worktrees={orphanWorktrees}
        mutationPending={mutationPending}
        onOpen={onOpenWorktree}
        onRename={onRenameWorktree}
        onRemove={onRemoveWorktree}
      />
    </>
  );
}
