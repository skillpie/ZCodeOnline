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
  onDeleteBranch: (branchName: string) => void;
  onOpenWorktree: (worktreePath: string) => void;
  onRenameWorktree: (worktree: GitWorktreeRecord) => void;
  onRemoveWorktree: (worktree: GitWorktreeRecord) => void;
}

/** worktree 目录名（路径末段），与子项展示名、创建时的副本分支净化名一致。 */
function worktreeDirName(worktreePath: string): string {
  return worktreePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
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
  onDeleteBranch,
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

  const worktreesByParentBranchName = useMemo(() => {
    const branchNames = new Set(branches.map((branch) => branch.name));
    const map = new Map<string, GitWorktreeRecord[]>();
    for (const worktree of worktrees) {
      if (!worktree.branchName) {
        continue;
      }
      // 优先挂来源分支（创建时记录在 repo config）；无记录或来源分支已不存在时，
      // 回退挂在副本自身分支下（旧数据形态）。
      const source = worktree.sourceBranchName;
      const parent =
        source && source !== worktree.branchName && branchNames.has(source)
          ? source
          : worktree.branchName;
      const group = map.get(parent);
      if (group) {
        group.push(worktree);
      } else {
        map.set(parent, [worktree]);
      }
    }
    return map;
  }, [branches, worktrees]);

  // 已被收进来源分支子列表的副本分支，不再出现在顶层分支列表（避免同一分支两行展示）。
  // 判定键是创建时的副本分支名（子项行名与之钉定）：worktree 内切分支后，被切走的分支名
  // 是普通分支，必须继续在顶层展示（如当前分支）。
  const consumedBranchNames = useMemo(() => {
    const consumed = new Set<string>();
    for (const worktree of worktrees) {
      if (!worktree.branchName) {
        // detached worktree 与分支无对应关系，不收起任何分支行。
        continue;
      }
      const represented = worktree.copyBranchName ?? worktreeDirName(worktree.path);
      if (represented) {
        consumed.add(represented);
      }
    }
    return consumed;
  }, [worktrees]);

  // detached / 分支已删除等无主 worktree：无法归组到任何分支行，落到兜底「Worktrees」分组。
  const orphanWorktrees = useMemo(() => {
    const branchNames = new Set(branches.map((branch) => branch.name));
    return worktrees.filter(
      (worktree) => !worktree.branchName || !branchNames.has(worktree.branchName),
    );
  }, [branches, worktrees]);

  const renderBranchRows = (branch: GitLocalBranch): ReactNode[] => {
    if (consumedBranchNames.has(branch.name)) {
      return [];
    }
    const branchWorktrees = worktreesByParentBranchName.get(branch.name) ?? [];
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
        onDeleteBranch={onDeleteBranch}
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
