// 远程控制弹窗的单条机器卡片（specs/web-tunnel.md §5.9）：从弹窗组件拆出以控制文件体量。
// 整卡即「切换」入口：点击非当前卡片把该链接存为当前生效码并重连（回调由弹窗提供），
// 当前连接卡片高亮边框 + 「当前」徽标、不再响应选中，改名中的卡片暂不响应。
// 首行展示本机/远端标签、「当前」徽标与名称（可就地改名），刷新（仅本机，触发由弹窗
// 持有的二次确认流程）与删除（仅非本机条目；当前连接条目禁用，需先切换）图标固定在
// 卡片右上角；次行为完整链接与复制（所有条目）。卡内按钮/输入框的交互不冒泡触发选中。
import type { AssistMachine } from "@/assistMachineStore.js";
import { maskAssistCodeForDisplay } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Check, Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";

interface AssistMachineRowCardProps {
  machine: AssistMachine;
  isLocal: boolean;
  /** 当前连接（高亮边框 + 「当前」徽标）：唯一事实由弹窗侧 resolveCurrentAssistCode 解析。 */
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
  /** 点击卡片选中切换（存为当前生效码并重连）；仅非当前且非改名中的卡片触发。 */
  onSelect: () => void;
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
  onSelect,
  onRemove,
}: AssistMachineRowCardProps) {
  const { intl } = useZCodeIntl();
  // 操作按钮属常用控件，按 DESIGN.md 用 text-ui-base；仅徽标保留 badge 级 text-ui-xs。
  const rowActionClass =
    "shrink-0 text-ui-base text-foreground-subtle hover:text-foreground disabled:cursor-default disabled:opacity-50";
  const selectable = !isActive && !editing;

  return (
    <div
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-current={isActive ? "true" : undefined}
      title={selectable ? intl.formatMessage({ id: "assistCode.dialog.switchTitle" }) : undefined}
      onClick={(event) => {
        if (!selectable) return;
        // 卡内重命名/刷新/删除/复制等自有交互不冒泡触发选中切换。
        if ((event.target as HTMLElement | null)?.closest("button, input")) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        // 键盘激活只认卡片自身焦点：焦点在卡内按钮上时 Enter/Space 属于按钮。
        if (!selectable || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "min-w-0 space-y-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
        isActive ? "border-input-border-focused bg-surface-hover/40" : "border-border bg-surface",
        selectable &&
          "cursor-pointer hover:border-input-border-focused hover:bg-surface-hover/40 focus-visible:border-input-border-focused",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
          {intl.formatMessage({
            id: isLocal ? "assistCode.dialog.localBadge" : "assistCode.dialog.remoteBadge",
          })}
        </span>
        {/* 当前连接徽标（对齐 MigrationCandidatesCard 的 border-primary + bg-accent 选中高亮）。 */}
        {isActive ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-primary/40 bg-accent px-2 text-ui-xs font-medium leading-none text-primary">
            {intl.formatMessage({ id: "assistCode.dialog.current" })}
          </span>
        ) : null}
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
            className={cn(rowActionClass, "ml-auto flex items-center gap-1")}
            aria-label={intl.formatMessage({ id: "assistCode.dialog.refreshTitle" })}
            title={intl.formatMessage({ id: "assistCode.dialog.refreshTitle" })}
            onClick={onRequestRefresh}
          >
            <RefreshCw className="size-3.5" />
            {intl.formatMessage({ id: "common.refresh" })}
          </button>
        ) : (
          <button
            type="button"
            className={cn(rowActionClass, "ml-auto flex items-center gap-1 hover:text-destructive")}
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
            {intl.formatMessage({ id: "assistCode.dialog.delete" })}
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
          {/* 链接展示脱敏中间 4 位（防旁人瞥见完整码）；复制走完整码（见 onCopy）。 */}
          {origin}/{maskAssistCodeForDisplay(machine.code)}
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
