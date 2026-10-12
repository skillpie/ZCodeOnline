import { type FormEvent } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LoaderIcon, SquarePenIcon } from "lucide-react";

interface GitWorktreeRenameDialogProps {
  open: boolean;
  branchName: string;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onBranchNameChange: (nextValue: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/**
 * 「重命名 Worktree」弹窗：输入新分支名；Host 侧会同步把分支重命名（git branch -m）
 * 并把目录移动到主树 .worktrees/<净化名>（git worktree move），保持目录名与分支名一致。
 */
export function GitWorktreeRenameDialog({
  open,
  branchName,
  mutationPending,
  onOpenChange,
  onBranchNameChange,
  onCancel,
  onSubmit,
}: GitWorktreeRenameDialogProps) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="flex items-center gap-2 text-lg font-medium text-foreground">
            <SquarePenIcon className="size-4 text-foreground-subtle" />
            {intl.formatMessage({
              id: "git.worktree.renameDialog.title",
            })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({
              id: "git.worktree.renameDialog.description",
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5 px-6 py-6"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="git-worktree-rename-input"
              className="inline-flex text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({
                id: "git.worktree.renameDialog.nameLabel",
              })}
            </label>
            <Input
              id="git-worktree-rename-input"
              size="lg"
              autoFocus
              value={branchName}
              disabled={mutationPending}
              placeholder={intl.formatMessage({
                id: "git.worktree.renameDialog.placeholder",
              })}
              className="h-10 rounded-lg bg-background/50"
              onChange={(event) => {
                onBranchNameChange(event.target.value);
              }}
            />
          </div>

          <DialogFooter className="gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={onCancel}
              disabled={mutationPending}
              className="h-10 min-w-0 px-5"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={mutationPending || branchName.trim().length === 0}
              className="h-10 min-w-0 px-5"
            >
              {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
              {intl.formatMessage({
                id: "git.worktree.renameDialog.confirm",
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
