// 远程控制弹窗的单条机器卡片（specs/web-tunnel.md §5.9）：从弹窗组件拆出以控制文件体量。
// 首行展示本机/远端标签与名称（可就地改名），刷新（仅本机，触发由弹窗持有的二次确认
// 流程）与删除（仅非本机条目；当前连接条目禁用，需先切换）图标固定在卡片右上角；
// 次行为完整链接与复制（所有条目）、切换（存为当前生效码并重连，当前连接条目禁用）。
import type { AssistMachine } from "@/assistMachineStore.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ArrowLeftRight, Check, Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";

interface AssistMachineRowCardProps {
  machine: AssistMachine;
  isLocal: boolean;
  isActive: boolean;
  editing: boolean;
  editDraft: string;
  copied: boolean;
  origin: string;
  onEditStart: () => void;
  onEditChange: (draft: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  onCopy: () => void;
  onRequestRefresh: () => void;
  onSwitch: () => void;
  onRemove: () => void;
}

export function AssistMachineRowCard({
  machine,
  isLocal,
  isActive,
  editing,
  editDraft,
  copied,
  origin,
  onEditStart,
  onEditChange,
  onEditCommit,
  onEditCancel,
  onCopy,
  onRequestRefresh,
  onSwitch,
  onRemove,
}: AssistMachineRowCardProps) {
  const { intl } = useZCodeIntl();
  // 操作按钮属常用控件，按 DESIGN.md 用 text-ui-base；仅徽标保留 badge 级 text-ui-xs。
  const rowActionClass =
    "shrink-0 text-ui-base text-foreground-subtle hover:text-foreground disabled:cursor-default disabled:opacity-50";

  return (
    <div
      className={cn(
        "min-w-0 space-y-1.5 rounded-xl border px-3 py-2.5",
        isActive ? "border-input-border-focused bg-surface-hover/40" : "border-border bg-surface",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
          {intl.formatMessage({
            id: isLocal ? "assistCode.dialog.localBadge" : "assistCode.dialog.remoteBadge",
          })}
        </span>
        {editing ? (
          <input
            autoFocus
            value={editDraft}
            aria-label={intl.formatMessage({ id: "assistCode.dialog.rename" })}
            className="min-w-0 flex-1 rounded-md border border-input-border-focused bg-background px-2 py-1 text-ui-base text-foreground outline-none"
            onChange={(event) => onEditChange(event.target.value)}
            onBlur={onEditCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") onEditCommit();
              if (event.key === "Escape") onEditCancel();
            }}
          />
        ) : (
          <>
            <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
              {machine.name}
            </span>
            <button
              type="button"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              aria-label={intl.formatMessage({ id: "assistCode.dialog.rename" })}
              title={intl.formatMessage({ id: "assistCode.dialog.rename" })}
              onClick={onEditStart}
            >
              <Pencil className="size-3.5" />
            </button>
          </>
        )}
        {isLocal ? (
          <button
            type="button"
            className={cn(rowActionClass, "ml-auto")}
            aria-label={intl.formatMessage({ id: "assistCode.dialog.refreshTitle" })}
            title={intl.formatMessage({ id: "assistCode.dialog.refreshTitle" })}
            onClick={onRequestRefresh}
          >
            <RefreshCw className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            className={cn(rowActionClass, "ml-auto hover:text-destructive")}
            disabled={isActive}
            aria-label={intl.formatMessage({ id: "assistCode.dialog.delete" })}
            title={
              isActive
                ? intl.formatMessage({ id: "assistCode.dialog.deleteActiveTitle" })
                : intl.formatMessage({ id: "assistCode.dialog.delete" })
            }
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
          {origin}/{machine.code}
        </code>
        <button
          type="button"
          className={cn(rowActionClass, "flex items-center gap-1")}
          aria-label={intl.formatMessage({ id: "assistCode.dialog.copy" })}
          title={intl.formatMessage({ id: "assistCode.dialog.copy" })}
          onClick={onCopy}
        >
          {copied ? (
            <>
              <Check className="size-3.5" />
              {intl.formatMessage({ id: "assistCode.dialog.copied" })}
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              {intl.formatMessage({ id: "assistCode.dialog.copy" })}
            </>
          )}
        </button>
        <button
          type="button"
          className={cn(rowActionClass, "flex items-center gap-1")}
          disabled={isActive}
          aria-label={intl.formatMessage({ id: "assistCode.dialog.switchTitle" })}
          title={
            isActive
              ? intl.formatMessage({ id: "assistCode.dialog.current" })
              : intl.formatMessage({ id: "assistCode.dialog.switchTitle" })
          }
          onClick={onSwitch}
        >
          <ArrowLeftRight className="size-3.5" />
          {intl.formatMessage({ id: "assistCode.dialog.switch" })}
        </button>
      </div>
    </div>
  );
}

/** 弹窗内通用的次要按钮（保持与共享确认弹窗一致的尺寸/留白）。 */
export function AssistDialogSecondaryButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button type="button" variant="secondary" size="lg" className="h-9 px-4" onClick={onClick}>
      {label}
    </Button>
  );
}
