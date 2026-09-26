/**
 * 数据源输入框常驻入口按钮（specs/data-source.md §7：会话级选择 + DB 工具提权）。
 *
 * 仿 V4ComposerCuaEntry 的双层结构：外层用 optional 变体判定 platform/services，
 * 缺失即不渲染，避免把无 provider 的宿主拖崩。点击弹出数据源面板（会话级选择/管理），
 * 面板内的「新建 / 管理」统一走同一个管理弹窗（open 状态在本组件持有）。
 *
 * 勾选与按钮文案跟随「会话级选择」（per-conversation binding，默认未选择）；
 * 点击列表项仍会激活该源（触发表结构同步、维持工具侧 activeId fallback）。
 */
import { memo, useState } from "react";
import {
  Check,
  ChevronDownIcon,
  CircleAlert,
  Database,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useDataSourceManager } from "@/hooks/useDataSource.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { DataSourceManagerDialog } from "./DataSourceManagerDialog.js";

interface V4ComposerDataSourceEntryProps {
  /** 当前会话绑定的数据源 id；null = 未选择（新建对话默认态，Agent 无 DB 工具）。 */
  selectedDataSourceId: string | null;
  /** 会话级选择回调；null = 取消选择（收回提权）。 */
  onSelectDataSource: (dataSourceId: string | null) => void;
}

function DataSourceEntryInner({
  selectedDataSourceId,
  onSelectDataSource,
}: V4ComposerDataSourceEntryProps) {
  const { intl } = useZCodeIntl();
  const { available, dataSources, activeId, syncStatus, syncError, activate, loading } =
    useDataSourceManager();
  const [panelOpen, setPanelOpen] = useState(false);
  /** 管理弹窗：null=关闭；"new"=直接进新建表单；其余=选中该数据源 */
  const [manageSelection, setManageSelection] = useState<string | null>(null);

  if (!available) return null;

  // 悬挂选择（源已被删除）按未选择展示；提交侧 SessionPane 同规则校验后携带。
  const selectedDataSource =
    dataSources.find((source) => source.id === selectedDataSourceId) ?? null;
  const label = intl.formatMessage({ id: "chat.toolbar.dataSource.label" });
  const anySyncing = Object.values(syncStatus).some((status) => status === "syncing");
  const selectedSyncError = selectedDataSource ? (syncError[selectedDataSource.id] ?? null) : null;

  return (
    <>
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.toolbar.dataSource.tooltip" })}>
        <Popover open={panelOpen} onOpenChange={setPanelOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="default"
              data-testid="composer-data-source-entry"
              data-composer-collapse-priority="1"
              aria-label={label}
              className="group/data-source h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:px-0"
            >
              <Database className="size-4 shrink-0" aria-hidden />
              {/* 未选择时不展示占位文案（specs/data-source.md §7.1）：按钮只有图标。 */}
              {selectedDataSource ? (
                <span
                  className="max-w-28 truncate whitespace-nowrap group-data-[composer-compact=true]/data-source:hidden"
                  data-data-source-caption
                >
                  {selectedDataSource.name}
                </span>
              ) : null}
              {anySyncing ? (
                <Loader2
                  className="size-3 shrink-0 animate-spin text-foreground-subtle"
                  aria-hidden
                />
              ) : (
                <ChevronDownIcon
                  className="pointer-events-none size-3.5 shrink-0 text-foreground-subtle group-data-[composer-compact=true]/data-source:hidden"
                  aria-hidden
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            className="w-80 gap-1 rounded-xl p-1"
            data-testid="composer-data-source-panel"
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-ui-base font-medium text-foreground">{label}</span>
              <span className="text-ui-sm text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "chat.toolbar.dataSource.count" },
                  { count: dataSources.length },
                )}
              </span>
            </div>
            <div
              className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
              role="listbox"
              aria-label={label}
            >
              {dataSources.length === 0 && !loading ? (
                <div className="px-3 py-6 text-center text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.toolbar.dataSource.empty" })}
                </div>
              ) : null}
              {dataSources.map((source) => {
                const isSelected = source.id === selectedDataSource?.id;
                const syncing = syncStatus[source.id] === "syncing";
                const failed = syncStatus[source.id] === "error";
                return (
                  <button
                    key={source.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={syncing}
                    onClick={() => {
                      // 再次点击已勾选项 = 本对话恢复不使用数据源（收回提权，§7.1）。
                      if (isSelected) {
                        onSelectDataSource(null);
                        return;
                      }
                      // 选择仍触发全局激活：同步表结构并维持工具侧 activeId fallback（§7.1）。
                      onSelectDataSource(source.id);
                      if (source.id !== activeId) void activate(source.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui-base hover:bg-menu-hover",
                      isSelected && "bg-menu-hover",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{source.name}</span>
                        <Badge variant="outline" className="h-4 shrink-0 px-1 text-ui-xs uppercase">
                          {source.type === "mysql" ? "MySQL" : "PG"}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 shrink-0 px-1 text-ui-xs",
                            source.readOnly
                              ? "text-foreground-subtle"
                              : "text-[var(--color-warning)]",
                          )}
                        >
                          {intl.formatMessage({
                            id: source.readOnly
                              ? "chat.toolbar.dataSource.readOnly"
                              : "chat.toolbar.dataSource.readWrite",
                          })}
                        </Badge>
                      </span>
                      <span className="block truncate font-mono text-ui-sm text-foreground-subtlest">
                        {source.host}:{source.port}/{source.database}
                      </span>
                    </span>
                    {syncing ? (
                      <Loader2
                        className="size-3.5 shrink-0 animate-spin text-foreground-subtle"
                        aria-hidden
                      />
                    ) : failed ? (
                      <CircleAlert
                        className="size-3.5 shrink-0 text-[var(--color-warning)]"
                        aria-hidden
                      />
                    ) : isSelected ? (
                      <Check
                        className="size-3.5 shrink-0 text-[var(--color-success)]"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {selectedSyncError ? (
              <div className="mx-1 mt-1 rounded-md bg-[var(--color-warning)]/10 px-2 py-1.5 text-ui-sm text-[var(--color-warning)]">
                {selectedSyncError}
              </div>
            ) : null}
            {/* 提权语义提示：选择是会话级事实，决定本对话中 Agent 是否可用 DB 工具。 */}
            <div className="px-2 pt-1 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.toolbar.dataSource.hint" })}
            </div>
            {/* 左：管理数据源（新建在管理弹窗里做）；右：同步当前会话选择源的表结构 */}
            <div className="mt-1 flex items-center justify-between border-t border-border px-1 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-ui-base"
                data-testid="composer-data-source-manage"
                onClick={() => {
                  setManageSelection(selectedDataSource?.id ?? activeId ?? "new");
                  setPanelOpen(false);
                }}
              >
                <Settings2 className="size-3.5" aria-hidden />
                {intl.formatMessage({ id: "chat.toolbar.dataSource.manage" })}
              </Button>
              {selectedDataSource ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-ui-base"
                  aria-label={intl.formatMessage({ id: "chat.toolbar.dataSource.syncSchema" })}
                  data-testid="composer-data-source-resync"
                  onClick={() => void activate(selectedDataSource.id)}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {intl.formatMessage({ id: "chat.toolbar.dataSource.syncSchema" })}
                </Button>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      </ControlHintTooltip>
      <DataSourceManagerDialog
        open={manageSelection !== null}
        onOpenChange={(open) => {
          if (!open) setManageSelection(null);
        }}
        initialSelection={manageSelection}
      />
    </>
  );
}

export const V4ComposerDataSourceEntry = memo(function V4ComposerDataSourceEntry(
  props: V4ComposerDataSourceEntryProps,
) {
  const services = useOptionalServices();
  if (!services) return null;
  return <DataSourceEntryInner {...props} />;
});
