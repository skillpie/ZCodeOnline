import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GitGraph, PlusIcon } from "lucide-react";

interface GitBranchPopoverFooterProps {
  /** 任一 git 变更（分支 / worktree）进行中时禁用入口，避免并发变更。 */
  disabled: boolean;
  onCreateBranchClick: () => void;
  onOpenGitGraphClick: () => void;
}

/** 分支切换器下拉底部的动作区：新建分支、Git 图谱。 */
export function GitBranchPopoverFooter({
  disabled,
  onCreateBranchClick,
  onOpenGitGraphClick,
}: GitBranchPopoverFooterProps) {
  const { intl } = useZCodeIntl();
  const buttonClassName =
    "w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground";

  return (
    <div className="border-t border-border p-1">
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className={buttonClassName}
        disabled={disabled}
        onClick={onCreateBranchClick}
      >
        <PlusIcon className="size-4 text-foreground-subtle" />
        {intl.formatMessage({
          id: "git.branchSwitcher.createAction",
        })}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className={buttonClassName}
        onClick={onOpenGitGraphClick}
      >
        <GitGraph className="size-4 text-foreground-subtle" />
        {intl.formatMessage({ id: "gitGraph.menuAction" })}
      </Button>
    </div>
  );
}
