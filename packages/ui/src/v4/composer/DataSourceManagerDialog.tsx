/**
 * 数据源管理弹窗：左侧数据源列表（新建/选中），右侧表单 + 表结构快照。
 * 附加式新功能，spec 见 specs/data-source.md；数据一律来自 useDataSourceManager 投影。
 */
import { useEffect, useState } from "react";
import { Check, CircleAlert, Loader2, Plus, RefreshCw } from "lucide-react";import type { DataSourceView } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useDataSourceManager } from "@/hooks/useDataSource.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { DataSourceForm } from "./DataSourceForm.js";

export interface DataSourceManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时的初始选中：数据源 id 或 "new"（新建表单）。关闭后置 null。 */
  initialSelection: string | null;
}

const NEW_SELECTION = "new";

export function DataSourceManagerDialog({
  open,
  onOpenChange,
  initialSelection,
}: DataSourceManagerDialogProps) {
  const { intl } = useZCodeIntl();
  const { dataSources } = useDataSourceManager();
  const [selection, setSelection] = useState<string>(NEW_SELECTION);

  useEffect(() => {
    if (open && initialSelection !== null) {
      setSelection(initialSelection);
    }
  }, [open, initialSelection]);

  const selectedSource =
    selection === NEW_SELECTION
      ? null
      : (dataSources.find((source) => source.id === selection) ?? null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,92vh)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-baseline gap-2 border-b border-border px-4 py-2">
          <DialogTitle className="shrink-0">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.manageTitle" })}
          </DialogTitle>
          <DialogDescription className="min-w-0 flex-1 truncate text-ui-sm">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.manageDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <DataSourceListSidebar selection={selection} onSelect={setSelection} />
          <div className="flex min-w-0 flex-1 flex-col">
            <DataSourceFormArea source={selectedSource} onDeleted={() => setSelection(NEW_SELECTION)} onSaved={(id) => setSelection(id)} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DataSourceListSidebar({
  selection,
  onSelect,
}: {
  selection: string;
  onSelect: (selection: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { dataSources, activeId } = useDataSourceManager();
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="p-2">
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-1.5"
          data-testid="data-source-sidebar-new"
          onClick={() => onSelect(NEW_SELECTION)}
        >
          <Plus className="size-3.5" aria-hidden />
          {intl.formatMessage({ id: "chat.toolbar.dataSource.new" })}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {dataSources.map((source) => {
          const selected = selection === source.id;
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => onSelect(source.id)}
              className={cn(
                "mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-base hover:bg-menu-hover",
                selected && "bg-selected",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{source.name}</span>
                <span className="block truncate font-mono text-ui-sm text-foreground-subtlest">
                  {source.host}:{source.port}/{source.database}
                </span>
              </span>
              {source.id === activeId ? (
                <Check className="size-3.5 shrink-0 text-[var(--color-success)]" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DataSourceFormArea({
  source,
  onSaved,
  onDeleted,
}: {
  source: DataSourceView | null;
  onSaved: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const { save, test, remove, resync } = useDataSourceManager();
  return (
    <>
      {/* key 随选中源变化重挂表单，清空上一次的输入与提示 */}
      <DataSourceForm
        key={source?.id ?? NEW_SELECTION}
        source={source}
        onSave={save}
        onTest={test}
        onDelete={remove}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
      {source ? (
        <DataSourceSchemaPanel sourceId={source.id} onResync={() => void resync(source.id)} />
      ) : null}
    </>
  );
}

/** 选中数据源的表结构快照视图：同步状态 + 表数量 + 表清单。 */
function DataSourceSchemaPanel({
  sourceId,
  onResync,
}: {
  sourceId: string;
  onResync: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { snapshots, syncStatus, ensureSnapshot } = useDataSourceManager();
  const snapshot = snapshots[sourceId];
  const syncing = syncStatus[sourceId] === "syncing";

  useEffect(() => {
    void ensureSnapshot(sourceId);
  }, [sourceId, ensureSnapshot]);

  const syncedLabel = snapshot
    ? intl.formatMessage(
        { id: "chat.toolbar.dataSource.syncedAt" },
        { time: new Date(snapshot.fetchedAt).toLocaleString() },
      )
    : intl.formatMessage({ id: "chat.toolbar.dataSource.notSynced" });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t border-border"
      data-testid="data-source-schema-panel"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <span className="text-ui-base font-medium">
          {intl.formatMessage({ id: "chat.toolbar.dataSource.schemaTitle" })}
        </span>
        {syncing ? (
          <Loader2 className="size-3.5 animate-spin text-foreground-subtle" aria-hidden />
        ) : syncStatus[sourceId] === "error" ? (
          <CircleAlert className="size-3.5 text-[var(--color-warning)]" aria-hidden />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtlest">
          {syncedLabel}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-ui-sm"
          disabled={syncing}
          onClick={onResync}
        >
          <RefreshCw className="size-3" aria-hidden />
          {intl.formatMessage({ id: "chat.toolbar.dataSource.resync" })}
        </Button>
      </div>
      {snapshot ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" data-testid="data-source-table-list">
          <div className="mb-1 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage(
              { id: "chat.toolbar.dataSource.tablesCount" },
              { count: snapshot.tables.length },
            )}
          </div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {snapshot.tables.slice(0, 100).map((table) => (
              <li key={table.name} className="flex min-w-0 items-baseline gap-1.5 text-ui-sm">
                <span className="truncate font-mono">{table.name}</span>
                {table.kind && table.kind !== "BASE TABLE" && table.kind !== "r" ? (
                  <Badge variant="outline" className="h-3.5 shrink-0 px-1 text-ui-xs uppercase">
                    {table.kind}
                  </Badge>
                ) : null}
                {table.comment ? (
                  <span className="truncate text-foreground-subtle">{table.comment}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
