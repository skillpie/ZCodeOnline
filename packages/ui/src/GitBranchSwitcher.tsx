import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GitRepositorySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import {
  GitBranchCreateDialog,
  GitBranchSwitchAssistDialog,
} from "@/git-branch-switcher/GitBranchDialogs.js";
import { GitGraphDialog } from "@/git-graph/GitGraphDialog.js";
import { useGitBranchSwitcher } from "@/hooks/useGitBranchSwitcher.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  matchesGitBranchSearch,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { GitBranchListRow } from "@/git-branch-switcher/GitBranchListRow.js";
import { GitBranchPopoverFooter } from "@/git-branch-switcher/GitBranchPopoverFooter.js";
import { GitWorktreeRenameDialog } from "@/git-branch-switcher/GitWorktreeRenameDialog.js";
import { GitWorktreeSection } from "@/git-branch-switcher/GitWorktreeSection.js";
import { useGitWorktreeActions } from "@/git-branch-switcher/useGitWorktreeActions.js";
import { ChevronDownIcon, GitBranchIcon, LoaderIcon } from "lucide-react";

/** cmdk 的分支搜索过滤：仅按分支名包含匹配。 */
function branchSearchFilter(value: string, search: string): number {
  return matchesGitBranchSearch(value, search) ? 1 : 0;
}

interface GitBranchSwitcherProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
  className?: string;
  triggerClassName?: string;
  popoverClassName?: string;
  branchListClassName?: string;
  markAsWorkspaceHeaderBranch?: boolean;
  popoverSide?: "top" | "bottom" | "left" | "right";
  avoidPopoverCollisions?: boolean;
  showFooterActions?: boolean;
  /** 头部弹窗专属：分支行 hover 时行尾提供对话动作——非当前分支「合并」、当前分支「拉取」，点击向当前对话发送提示词。 */
  enableConversationActions?: boolean;
}

export function GitBranchSwitcher({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  dirtyFileCount,
  onRefreshGit,
  className,
  triggerClassName,
  popoverClassName,
  branchListClassName,
  markAsWorkspaceHeaderBranch = false,
  popoverSide = "top",
  avoidPopoverCollisions = true,
  showFooterActions = true,
  enableConversationActions = false,
}: GitBranchSwitcherProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const commandListRef = useRef<HTMLDivElement | null>(null);
  const [gitGraphDialogOpen, setGitGraphDialogOpen] = useState(false);
  const {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    deleteBranch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  } = useGitBranchSwitcher({
    workspacePath,
    currentBranchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    onRefreshGit,
  });
  const {
    worktreesResult,
    worktreePending,
    openWorktreeTab,
    checkoutBranchAsWorktree,
    removeWorktree,
    renameTarget,
    renameBranchName,
    setRenameBranchName,
    openRenameDialog,
    closeRenameDialog,
    submitRename,
  } = useGitWorktreeActions({ workspacePath, open, branchesResult });
  // 分支与 worktree 是同一仓库的两类 git 变更，任一进行中都统一禁用列表动作，避免并发变更。
  const listMutationPending = mutationPending || worktreePending;
  const handleOpenWorktree = useCallback(
    (worktreePath: string) => {
      setOpen(false);
      openWorktreeTab(worktreePath);
    },
    [openWorktreeTab, setOpen],
  );

  const isVisible = gitSummary.isGitAvailable && gitSummary.isRepository;
  const displayedCurrentBranchName = branchesResult?.currentBranchName ?? gitSummary.branchName;
  // 正被某个 worktree 检出的分支属于“工作中”，不提供删除入口。
  const branchNamesInWorktrees = new Set(
    (worktreesResult?.worktrees ?? []).flatMap((worktree) =>
      worktree.branchName ? [worktree.branchName] : [],
    ),
  );
  const handleCheckoutAsWorktree = useCallback(
    (branchName: string) => {
      setOpen(false);
      void checkoutBranchAsWorktree(branchName);
    },
    [checkoutBranchAsWorktree, setOpen],
  );
  const handleDeleteBranch = useCallback(
    (branchName: string) => {
      setOpen(false);
      void deleteBranch(branchName);
    },
    [deleteBranch, setOpen],
  );
  const triggerLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: displayedCurrentBranchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [displayedCurrentBranchName, gitSummary.headRefType, intl],
  );
  const currentBranchDirtyLabel =
    dirtyFileCount > 0
      ? intl.formatMessage(
          { id: "git.branchSwitcher.currentDirty" },
          { count: numberFormatter.format(dirtyFileCount) },
        )
      : null;
  const switchAssistCurrentBranchLabel = useMemo(() => {
    if (!switchAssistState) {
      return triggerLabel;
    }

    return resolveGitBranchTriggerLabel({
      headRefType: gitSummary.headRefType,
      currentBranchName: switchAssistState.currentBranchName,
      detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
      fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
    });
  }, [gitSummary.headRefType, intl, switchAssistState, triggerLabel]);

  const conversationPromptScope = { workspacePath, workspaceIdentity };

  useEffect(() => {
    if (!open || !branchesResult?.branches.length) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const selectedItem =
        commandListRef.current?.querySelector<HTMLElement>('[data-branch-current="true"]') ?? null;
      selectedItem?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [branchesResult, open]);

  const handleContentKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }

    const highlightedItem =
      event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="command-item"][data-selected="true"]:not([data-disabled=true])',
      ) ??
      event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="command-item"]:not([data-disabled=true])',
      );

    if (!highlightedItem) {
      return;
    }

    event.preventDefault();
    highlightedItem.click();
  }, []);

  if (!isVisible) {
    return null;
  }

  return (
    <>
      <div
        data-workspace-header-branch={markAsWorkspaceHeaderBranch ? "true" : undefined}
        className={cn("flex items-center px-1 pt-2", className)}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={"default"}
              disabled={mutationPending}
              aria-label={intl.formatMessage({
                id: "git.branchSwitcher.trigger.ariaLabel",
              })}
              className={cn(
                "min-w-0 rounded-full text-ui-base/relaxed",
                "max-w-full pl-3 pr-2",
                triggerClassName,
              )}
            >
              <GitBranchIcon
                data-branch-switcher-primary-icon="true"
                className="size-4 text-foreground-subtle"
              />
              <>
                <span className="min-w-0 max-w-25 truncate text-left">{triggerLabel}</span>
                {loadingBranches || mutationPending ? (
                  <LoaderIcon
                    data-branch-switcher-trailing-icon="true"
                    className="size-3.5 animate-spin text-foreground-subtle"
                  />
                ) : (
                  <ChevronDownIcon
                    data-branch-switcher-trailing-icon="true"
                    className="size-3.5 text-foreground-subtle"
                  />
                )}
              </>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side={popoverSide}
            avoidCollisions={avoidPopoverCollisions}
            className={cn("w-80 gap-0 bg-menu p-0", popoverClassName)}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (isCoarseTouchDevice()) {
                // 手机触控设备打开分支列表时，自动聚焦搜索框会拉起系统键盘遮挡列表。
                // 移动端保留触发器焦点，用户需要搜索时再手动点输入框；桌面端继续自动进入搜索。
                return;
              }

              const target = event.currentTarget;
              if (!(target instanceof HTMLElement)) {
                return;
              }
              const searchInput = target.querySelector<HTMLElement>('[data-slot="command-input"]');
              searchInput?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                !shouldRestoreChatInputFocusAfterPickerClose({
                  isCoarseTouchDevice: isCoarseTouchDevice(),
                })
              ) {
                return;
              }
              const input = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
              input?.focus();
            }}
          >
            <Command
              className="bg-transparent p-0 text-foreground"
              filter={branchSearchFilter}
              onKeyDown={handleContentKeyDown}
            >
              <CommandInput
                placeholder={intl.formatMessage({
                  id: "git.branchSwitcher.searchPlaceholder",
                })}
                className="h-8"
              />
              <CommandList ref={commandListRef} className={cn("max-h-72", branchListClassName)}>
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {loadingBranches
                    ? intl.formatMessage({ id: "common.loading" })
                    : intl.formatMessage({ id: "git.branchSwitcher.empty" })}
                </CommandEmpty>
                <CommandGroup
                  heading={intl.formatMessage({
                    id: "git.branchSwitcher.section.branches",
                  })}
                  className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
                >
                  {(branchesResult?.branches ?? []).map((branch) => (
                    <GitBranchListRow
                      key={branch.name}
                      branch={branch}
                      isCurrent={branch.name === displayedCurrentBranchName}
                      currentDirtyLabel={currentBranchDirtyLabel}
                      mutationPending={listMutationPending}
                      onSwitch={switchBranch}
                      enableConversationAction={enableConversationActions}
                      conversationPromptScope={conversationPromptScope}
                      onConversationActionTriggered={() => {
                        setOpen(false);
                      }}
                      onCheckoutAsWorktree={handleCheckoutAsWorktree}
                      onDeleteBranch={handleDeleteBranch}
                      checkedOutInWorktree={branchNamesInWorktrees.has(branch.name)}
                    />
                  ))}
                </CommandGroup>
                <GitWorktreeSection
                  worktrees={worktreesResult?.worktrees ?? []}
                  mutationPending={listMutationPending}
                  onOpen={handleOpenWorktree}
                  onRename={openRenameDialog}
                  onRemove={removeWorktree}
                />
              </CommandList>
            </Command>
            {showFooterActions ? (
              <GitBranchPopoverFooter
                disabled={listMutationPending}
                onCreateBranchClick={() => {
                  setOpen(false);
                  setCreateDialogOpen(true);
                }}
                onOpenGitGraphClick={() => {
                  setOpen(false);
                  setGitGraphDialogOpen(true);
                }}
              />
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      <GitBranchCreateDialog
        open={createDialogOpen}
        branchName={createBranchName}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          setCreateDialogOpen(nextOpen);
          if (!nextOpen) {
            setCreateBranchName("");
          }
        }}
        onBranchNameChange={setCreateBranchName}
        onCancel={() => {
          setCreateDialogOpen(false);
          setCreateBranchName("");
        }}
        onSubmit={() => {
          void createBranchAndSwitch();
        }}
      />

      <GitWorktreeRenameDialog
        open={Boolean(renameTarget)}
        branchName={renameBranchName}
        mutationPending={worktreePending}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeRenameDialog();
          }
        }}
        onBranchNameChange={setRenameBranchName}
        onCancel={closeRenameDialog}
        onSubmit={() => {
          void submitRename();
        }}
      />

      <GitGraphDialog
        open={gitGraphDialogOpen}
        workspacePath={workspacePath}
        onOpenChange={setGitGraphDialogOpen}
      />

      <GitBranchSwitchAssistDialog
        step={switchAssistStep}
        state={switchAssistState}
        currentBranchLabel={switchAssistCurrentBranchLabel}
        commitMessage={commitMessage}
        commitError={commitError}
        mutationPending={mutationPending}
        onClose={closeSwitchAssistDialog}
        onOpenCommit={openSwitchCommitDialog}
        onCommitMessageChange={setCommitMessage}
        onSubmit={() => {
          void commitAndSwitchBranch();
        }}
      />
    </>
  );
}
