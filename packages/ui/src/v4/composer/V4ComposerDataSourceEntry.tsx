/**
 * 数据源输入框常驻入口按钮（附加式新功能，spec 见 specs/data-source.md）。
 *
 * 仿 V4ComposerCuaEntry 的双层结构：外层用 optional 变体判定 platform/services，
 * 缺失即不渲染，避免把无 provider 的宿主拖崩。点击弹出数据源面板（切换/管理），
 * 面板内的「新建 / 管理」统一走同一个管理弹窗（open 状态在本组件持有）。
 */
import { memo, useState } from "react";
import { Check, ChevronDownIcon, CircleAlert, Database, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useDataSourceManager } from "@/hooks/useDataSource.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { DataSourceManagerDialog } from "./DataSourceManagerDialog.js";

function DataSourceEntryInner() {
  const { intl } = useZCodeIntl();
  const {
    available,
    dataSources,
    activeId,
    activeDataSource,
    syncStatus,
    syncError,
    activate,
    loading,
  } = useDataSourceManager();
  const [panelOpen, setPanelOpen] = useState(false);
  /** 管理弹窗：null=关闭；"new"=直接进新建表单；其余=选中该数据源 */
  const [manageSelection, setManageSelection] = useState<string | null>(null);

  if (!available) return null;

  const label = intl.formatMessage({ id: "chat.toolbar.dataSource.label" });
  const caption = activeDataSource
    ? activeDataSource.name
    : intl.formatMessage({ id: "chat.toolbar.dataSource.none" });
  const anySyncing = Object.values(syncStatus).some((status) => status === "syncing");
  const activeSyncError = activeId ? (syncError[activeId] ?? null) : null;

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
              className="h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base"
            >
              <Database className="size-4 shrink-0" aria-hidden />
              <span
                className="hidden max-w-28 truncate whitespace-nowrap @xl/composer:inline-flex"
                data-data-source-caption
              >
                {caption}
              </span>
              {anySyncing ? (
                <Loader2
                  className="size-3 shrink-0 animate-spin text-foreground-subtle"
                  aria-hidden
                />
              ) : (
                <ChevronDownIcon
                  className="pointer-events-none size-3.5 shrink-0 text-foreground-subtle"
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
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label={label}>
              {dataSources.length === 0 && !loading ? (
                <div className="px-3 py-6 text-center text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.toolbar.dataSource.empty" })}
                </div>
              ) : null}
              {dataSources.map((source) => {
                const isActive = source.id === activeId;
                const syncing = syncStatus[source.id] === "syncing";
                const failed = syncStatus[source.id] === "error";
                return (
                  <button
                    key={source.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    disabled={syncing}
                    onClick={() => {
                      if (!isActive) void activate(source.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui-base hover:bg-menu-hover",
                      isActive && "bg-menu-hover",
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
                            source.readOnly ? "text-foreground-subtle" : "text-[var(--color-warning)]",
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
                    ) : isActive ? (
                      <Check className="size-3.5 shrink-0 text-[var(--color-success)]" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {activeSyncError ? (
              <div className="mx-1 mt-1 rounded-md bg-[var(--color-warning)]/10 px-2 py-1.5 text-ui-sm text-[var(--color-warning)]">
                {activeSyncError}
              </div>
            ) : null}
            {/* 左：管理数据源（新建在管理弹窗里做）；右：同步当前激活源表结构 */}
            <div className="mt-1 flex items-center justify-between border-t border-border px-1 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-ui-base"
                data-testid="composer-data-source-manage"
                onClick={() => {
                  setManageSelection(activeId ?? "new");
                  setPanelOpen(false);
                }}
              >
                <Settings2 className="size-3.5" aria-hidden />
                {intl.formatMessage({ id: "chat.toolbar.dataSource.manage" })}
              </Button>
              {activeId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-ui-base"
                  aria-label={intl.formatMessage({ id: "chat.toolbar.dataSource.syncSchema" })}
                  data-testid="composer-data-source-resync"
                  onClick={() => void activate(activeId)}
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

export const V4ComposerDataSourceEntry = memo(function V4ComposerDataSourceEntry() {
  const services = useOptionalServices();
  if (!services) return null;
  return <DataSourceEntryInner />;
});
