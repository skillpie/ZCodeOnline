/**
 * 数据源表单（新建 / 编辑）。
 * 交互契约：测试通过与否由用户点击「测试连接」决定；保存不做隐式连接测试
 * （与参考实现一致，避免保存被网络超时拖死）。编辑时密码留空 = 保持原密码。
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  DataSourceInput,
  DataSourceMutationResult,
  DataSourceType,
  DataSourceView,
} from "@zcode/shared";
import { DATA_SOURCE_DEFAULT_PORTS, DATA_SOURCE_TYPES } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSourceTestOutcome } from "@/store/dataSourceStore.js";

export interface DataSourceFormProps {
  /** null = 新建 */
  source: DataSourceView | null;
  onSave: (input: DataSourceInput) => Promise<DataSourceMutationResult>;
  onTest: (input: DataSourceInput) => Promise<DataSourceTestOutcome>;
  onDelete: (id: string) => Promise<void>;
  /** 保存成功 / 删除成功后的收尾（父组件决定选中态） */
  onSaved: (id: string) => void;
  onDeleted: (id: string) => void;
}

interface FormState {
  type: DataSourceType;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  readOnly: boolean;
}

function toInput(state: FormState, source: DataSourceView | null): DataSourceInput {
  const port = Number.parseInt(state.port, 10);
  return {
    id: source?.id,
    type: state.type,
    name: state.name.trim() || undefined,
    host: state.host,
    port: Number.isInteger(port) ? port : undefined,
    user: state.user,
    password: state.password || undefined,
    database: state.database,
    readOnly: state.readOnly,
  };
}

export function DataSourceForm({
  source,
  onSave,
  onTest,
  onDelete,
  onSaved,
  onDeleted,
}: DataSourceFormProps) {
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [state, setState] = useState<FormState>(() => ({
    type: source?.type ?? "mysql",
    name: source?.name ?? "",
    host: source?.host ?? "",
    port: source ? String(source.port) : "",
    user: source?.user ?? "",
    // 编辑态永远不回填明文（父组件只给脱敏视图）；留空提交 = 保持原密码
    password: "",
    database: source?.database ?? "",
    readOnly: source ? source.readOnly : true,
  }));
  const [busy, setBusy] = useState<"none" | "testing" | "saving" | "deleting">("none");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const patch = (next: Partial<FormState>) => setState((prev) => ({ ...prev, ...next }));

  const handleTest = async () => {
    setBusy("testing");
    setMessage(null);
    try {
      const outcome = await onTest(toInput(state, source));
      setMessage(
        outcome.ok
          ? {
              kind: "ok",
              text: intl.formatMessage(
                { id: "chat.toolbar.dataSource.form.testOk" },
                { version: outcome.version || "?" },
              ),
            }
          : {
              kind: "error",
              text:
                outcome.error ??
                intl.formatMessage({ id: "chat.toolbar.dataSource.form.testFailed" }),
            },
      );
    } finally {
      setBusy("none");
    }
  };

  const handleSave = async () => {
    setBusy("saving");
    setMessage(null);
    try {
      const result = await onSave(toInput(state, source));
      setMessage(
        result.syncError
          ? {
              kind: "error",
              text: intl.formatMessage(
                { id: "chat.toolbar.dataSource.syncFailed" },
                { message: result.syncError },
              ),
            }
          : {
              kind: "ok",
              text: intl.formatMessage(
                { id: "chat.toolbar.dataSource.syncDone" },
                { count: result.schema?.tables.length ?? 0 },
              ),
            },
      );
      onSaved(result.dataSource.id);
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy("none");
    }
  };

  const handleDelete = async () => {
    if (!source) return;
    const confirmed = await requestConfirmation({
      title: intl.formatMessage(
        { id: "chat.toolbar.dataSource.deleteConfirmTitle" },
        { name: source.name },
      ),
      description: intl.formatMessage({ id: "chat.toolbar.dataSource.deleteConfirmBody" }),
      confirmLabel: intl.formatMessage({ id: "chat.toolbar.dataSource.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setBusy("deleting");
    try {
      await onDelete(source.id);
      onDeleted(source.id);
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      setBusy("none");
    }
  };

  const busyTesting = busy === "testing";
  const busySaving = busy === "saving";
  const canSave = state.host.trim().length > 0 && state.database.trim().length > 0 && !busySaving;

  return (
    <form
      className="flex shrink-0 flex-col gap-2 px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void handleSave();
      }}
    >
      <div className="grid grid-cols-3 gap-x-3 gap-y-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-type" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.type" })}
          </Label>
          <Select
            value={state.type}
            onValueChange={(value) => patch({ type: value as DataSourceType })}
          >
            <SelectTrigger id="data-source-type" size="lg" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATA_SOURCE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type === "mysql" ? "MySQL" : "PostgreSQL"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-name" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.name" })}
          </Label>
          <Input
            id="data-source-name"
            className="h-8"
            value={state.name}
            placeholder={intl.formatMessage({ id: "chat.toolbar.dataSource.form.namePlaceholder" })}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-host" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.host" })}
          </Label>
          <Input
            id="data-source-host"
            className="h-8 font-mono"
            value={state.host}
            placeholder="127.0.0.1"
            required
            onChange={(event) => patch({ host: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-port" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.port" })}
          </Label>
          <Input
            id="data-source-port"
            className="h-8 font-mono"
            inputMode="numeric"
            value={state.port}
            placeholder={String(DATA_SOURCE_DEFAULT_PORTS[state.type])}
            onChange={(event) => patch({ port: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-user" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.user" })}
          </Label>
          <Input
            id="data-source-user"
            className="h-8 font-mono"
            value={state.user}
            autoComplete="off"
            placeholder={state.type === "mysql" ? "root" : "postgres"}
            onChange={(event) => patch({ user: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-password" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.password" })}
          </Label>
          <Input
            id="data-source-password"
            className="h-8"
            type="password"
            value={state.password}
            autoComplete="new-password"
            placeholder={
              source
                ? intl.formatMessage({ id: "chat.toolbar.dataSource.form.passwordKeep" })
                : undefined
            }
            onChange={(event) => patch({ password: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-database" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.database" })}
          </Label>
          <Input
            id="data-source-database"
            className="h-8 font-mono"
            value={state.database}
            required
            onChange={(event) => patch({ database: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="data-source-mode" className="text-ui-base">
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.mode" })}
          </Label>
          <Select
            value={state.readOnly ? "read-only" : "read-write"}
            onValueChange={(value) => patch({ readOnly: value === "read-only" })}
          >
            <SelectTrigger id="data-source-mode" size="lg" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read-only">
                {intl.formatMessage({ id: "chat.toolbar.dataSource.readOnly" })}
              </SelectItem>
              <SelectItem value="read-write">
                {intl.formatMessage({ id: "chat.toolbar.dataSource.readWrite" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {message ? (
        <div
          role="status"
          className={
            message.kind === "ok"
              ? "rounded-md bg-[var(--color-success)]/10 px-2.5 py-1 text-ui-base text-[var(--color-success)]"
              : "rounded-md bg-[var(--color-warning)]/10 px-2.5 py-1 text-ui-base text-[var(--color-warning)]"
          }
        >
          {message.text}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busyTesting}
          onClick={() => void handleTest()}
        >
          {busyTesting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {intl.formatMessage({
            id: busyTesting
              ? "chat.toolbar.dataSource.form.testing"
              : "chat.toolbar.dataSource.form.test",
          })}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {source ? (
            <Button
              type="button"
              variant="ghost"
              className="text-[var(--color-destructive)]"
              disabled={busy === "deleting"}
              onClick={() => void handleDelete()}
            >
              {intl.formatMessage({ id: "chat.toolbar.dataSource.delete" })}
            </Button>
          ) : null}
          <Button type="submit" disabled={!canSave}>
            {busySaving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {intl.formatMessage({ id: "chat.toolbar.dataSource.form.save" })}
          </Button>
        </div>
      </div>
    </form>
  );
}
