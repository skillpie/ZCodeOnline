// 远程控制弹窗（specs/web-tunnel.md §5.9）：Web 版侧栏设置按钮左侧的图标按钮。
// 弹窗展示远程链接列表：本机（回环发现端点的权威码）固定第一项并带「本机」标签，
// 额外多一个「刷新」（二次确认后轮换本机码，旧链接立即失效）；其余条目来自浏览器
// 登记的远程链接列表，均支持改名（默认名 = <远程码>的ZCode）、「复制」「切换」与
// 手动添加/删除。本机条目卡片见 AssistMachineRowCard.tsx。
// 「切换」保存该链接为当前生效码并整页重连；仅当 platform 实现了远程码契约
// （浏览器与宿主同机的 Web 端）时渲染本入口，轮换权威所有者在宿主 Core 隧道运行时。
import { useState } from "react";
import { Loader2, MonitorSmartphone, Plus } from "lucide-react";
import { normalizeAssistCode } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  defaultAssistMachineName,
  loadAssistMachines,
  loadStoredAssistCode,
  removeAssistMachine,
  renameAssistMachine,
  replaceAssistMachineCode,
  saveStoredAssistCode,
  upsertAssistMachine,
  type AssistMachine,
} from "@/assistMachineStore.js";
import { AssistDialogSecondaryButton, AssistMachineRowCard } from "@/AssistMachineRowCard.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type AssistDialogPhase = "loading" | "ready" | "confirm" | "refreshing" | "error";

/** 本机条目置顶，其余按登记顺序。 */
function orderMachines(list: AssistMachine[], localCode: string | null): AssistMachine[] {
  if (!localCode) return list;
  return [
    ...list.filter((machine) => machine.code === localCode),
    ...list.filter((machine) => machine.code !== localCode),
  ];
}

export function WorkspaceAssistCodeRefreshTrigger({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<AssistDialogPhase>("loading");
  const [machines, setMachines] = useState<AssistMachine[]>([]);
  const [localCode, setLocalCode] = useState<string | null>(null);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addCodeDraft, setAddCodeDraft] = useState("");
  const [addNameDraft, setAddNameDraft] = useState("");
  const [addFormError, setAddFormError] = useState<string | null>(null);

  // 桌面端走 daemon 控制链路（暂未暴露远程码契约），未实现的平台直接不渲染入口。
  if (typeof platform.refreshRemoteAssistCode !== "function") {
    return null;
  }

  const getRemoteAssistCode = platform.getRemoteAssistCode?.bind(platform);
  const refreshRemoteAssistCode = platform.refreshRemoteAssistCode.bind(platform);
  const origin = window.location.origin;

  const loadCurrent = () => {
    setPhase("loading");
    setErrorCode(null);
    setRotated(false);
    setActiveCode(loadStoredAssistCode());
    // 平台实现内部已做"宿主不可达 → 回退本地存储"的兜底；local 为空时仍可展示已登记
    // 的远程链接（仅缺本机条目与刷新能力）。
    const finish = (local: string | null) => {
      if (local) upsertAssistMachine(local);
      setLocalCode(local);
      setMachines(orderMachines(loadAssistMachines(), local));
      setPhase("ready");
    };
    if (!getRemoteAssistCode) {
      finish(null);
      return;
    }
    void getRemoteAssistCode()
      .then((result) => finish(result.code))
      .catch((cause: unknown) => {
        if (loadAssistMachines().length > 0) {
          finish(null);
          return;
        }
        logger.warn("[WorkspaceAssistCodeRefreshTrigger] 读取远程码失败", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
        setErrorCode(cause instanceof Error ? cause.message : String(cause));
        setPhase("error");
      });
  };

  const resetAndOpen = () => {
    setMachines([]);
    setLocalCode(null);
    setCopiedCode(null);
    setEditingCode(null);
    setAdding(false);
    setAddCodeDraft("");
    setAddNameDraft("");
    setAddFormError(null);
    setOpen(true);
    loadCurrent();
  };

  const runRefresh = (previousLocalCode: string) => {
    setPhase("refreshing");
    setErrorCode(null);
    void refreshRemoteAssistCode()
      .then((result) => {
        // 轮换后同步列表（旧码条目换成新码、保留名称）；活动码由平台实现已回写。
        replaceAssistMachineCode(previousLocalCode, result.code);
        setLocalCode(result.code);
        setMachines(orderMachines(loadAssistMachines(), result.code));
        setRotated(true);
        setCopiedCode(null);
        setPhase("ready");
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[WorkspaceAssistCodeRefreshTrigger] 刷新远程码失败", { message });
        setErrorCode(message);
        setPhase("error");
      });
  };

  const switchTo = (code: string) => {
    saveStoredAssistCode(code);
    // 整页重连：挂载流程会以存储的当前码直连目标机器（含失效回退）。
    window.location.reload();
  };

  const copyShareUrl = (code: string) => {
    void navigator.clipboard.writeText(`${origin}/${code}`).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((current) => (current === code ? null : current)), 2_000);
    });
  };

  const commitRename = (code: string) => {
    const draft = editingDraft;
    setEditingCode(null);
    setEditingDraft("");
    renameAssistMachine(code, draft);
    const fallbackName = draft.trim() ? draft.trim() : defaultAssistMachineName(code);
    setMachines((rows) =>
      rows.map((machine) => (machine.code === code ? { ...machine, name: fallbackName } : machine)),
    );
  };

  const closeAddForm = () => {
    setAdding(false);
    setAddCodeDraft("");
    setAddNameDraft("");
    setAddFormError(null);
  };

  // 手动添加：码校验通过才入库；可选名称立即生效，否则走默认名（<码>的ZCode）。
  const submitAdd = () => {
    const code = normalizeAssistCode(addCodeDraft);
    if (!code) {
      setAddFormError(intl.formatMessage({ id: "assistCode.dialog.addInvalid" }));
      return;
    }
    if (code === localCode || loadAssistMachines().some((machine) => machine.code === code)) {
      setAddFormError(intl.formatMessage({ id: "assistCode.dialog.addDuplicate" }));
      return;
    }
    upsertAssistMachine(code);
    const name = addNameDraft.trim();
    if (name) renameAssistMachine(code, name);
    setMachines(orderMachines(loadAssistMachines(), localCode));
    closeAddForm();
  };

  // 删除仅移除列表记录；活动行已被禁用，不会删掉当前连接目标。
  const removeRow = (code: string) => {
    setMachines(orderMachines(removeAssistMachine(code), localCode));
  };

  const addInputClass =
    "w-full rounded-md border border-input-border-focused bg-background px-2 py-1 text-ui-base text-foreground outline-none";

  return (
    <>
      <ControlHintTooltip title={intl.formatMessage({ id: "assistCode.dialog.trigger" })}>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={intl.formatMessage({ id: "assistCode.dialog.trigger" })}
          className={cn("text-foreground hover:bg-surface-hover hover:text-foreground", className)}
          onClick={resetAndOpen}
        >
          <MonitorSmartphone className="size-4" />
        </Button>
      </ControlHintTooltip>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          // 刷新进行中不允许误关：Esc/遮罩只在工作完成或未开始时可关闭。
          if (phase === "refreshing") return;
          setOpen(nextOpen);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100vh-6rem)] gap-5 overflow-y-auto rounded-2xl sm:max-w-md"
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "assistCode.dialog.title" })}
            </DialogTitle>
            <DialogDescription className="pt-0.5 text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({ id: "assistCode.dialog.description" })}
            </DialogDescription>
          </DialogHeader>

          {phase === "confirm" ? (
            <p className="text-ui-base/relaxed text-foreground">
              {intl.formatMessage({ id: "assistCode.dialog.refreshWarning" })}
            </p>
          ) : null}

          {machines.length > 0 ? (
            <div className="space-y-2">
              {rotated && phase === "ready" ? (
                <div className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "assistCode.dialog.refreshed" })}
                </div>
              ) : null}
              {machines.map((machine) => {
                const isLocal = machine.code === localCode;
                const isActive = machine.code === activeCode;
                return (
                  <AssistMachineRowCard
                    key={machine.code}
                    machine={machine}
                    isLocal={isLocal}
                    isActive={isActive}
                    editing={editingCode === machine.code}
                    editDraft={editingCode === machine.code ? editingDraft : ""}
                    copied={copiedCode === machine.code}
                    origin={origin}
                    onEditStart={() => {
                      setEditingCode(machine.code);
                      setEditingDraft(machine.name);
                    }}
                    onEditChange={setEditingDraft}
                    onEditCommit={() => commitRename(machine.code)}
                    onEditCancel={() => {
                      setEditingCode(null);
                      setEditingDraft("");
                    }}
                    onCopy={() => copyShareUrl(machine.code)}
                    onRequestRefresh={() => setPhase("confirm")}
                    onSwitch={() => switchTo(machine.code)}
                    onRemove={() => removeRow(machine.code)}
                  />
                );
              })}
              <p className="text-ui-xs/relaxed text-foreground-subtle">
                {intl.formatMessage({ id: "assistCode.dialog.switchHint" })}
              </p>
              {adding ? (
                <div className="space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5">
                  <input
                    autoFocus
                    value={addCodeDraft}
                    inputMode="numeric"
                    aria-label={intl.formatMessage({ id: "assistCode.dialog.addCodePlaceholder" })}
                    placeholder={intl.formatMessage({ id: "assistCode.dialog.addCodePlaceholder" })}
                    className={addInputClass}
                    onChange={(event) => {
                      setAddCodeDraft(event.target.value);
                      setAddFormError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitAdd();
                      if (event.key === "Escape") closeAddForm();
                    }}
                  />
                  <input
                    value={addNameDraft}
                    aria-label={intl.formatMessage({ id: "assistCode.dialog.addNamePlaceholder" })}
                    placeholder={
                      normalizeAssistCode(addCodeDraft)
                        ? defaultAssistMachineName(normalizeAssistCode(addCodeDraft) ?? "")
                        : intl.formatMessage({ id: "assistCode.dialog.addNamePlaceholder" })
                    }
                    className={addInputClass}
                    onChange={(event) => setAddNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitAdd();
                      if (event.key === "Escape") closeAddForm();
                    }}
                  />
                  {addFormError !== null ? (
                    <p className="text-ui-xs text-destructive">{addFormError}</p>
                  ) : null}
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      className="text-ui-xs text-foreground-subtle hover:text-foreground"
                      onClick={closeAddForm}
                    >
                      {intl.formatMessage({ id: "common.cancel" })}
                    </button>
                    <button
                      type="button"
                      className="text-ui-xs font-medium text-primary hover:text-primary"
                      onClick={submitAdd}
                    >
                      {intl.formatMessage({ id: "assistCode.dialog.addConfirm" })}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-1 text-ui-xs text-primary hover:text-primary"
                  onClick={() => {
                    setAdding(true);
                    setAddFormError(null);
                  }}
                >
                  <Plus className="size-3.5" />
                  {intl.formatMessage({ id: "assistCode.dialog.add" })}
                </button>
              )}
            </div>
          ) : null}

          {phase === "loading" ? (
            <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" />
              {intl.formatMessage({ id: "assistCode.dialog.loading" })}
            </div>
          ) : null}

          {phase === "error" ? (
            <p className="break-all text-ui-base/relaxed text-destructive">{errorCode}</p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-end">
            {phase === "confirm" ? (
              <>
                <AssistDialogSecondaryButton
                  label={intl.formatMessage({ id: "common.cancel" })}
                  onClick={() => setPhase("ready")}
                />
                <Button
                  type="button"
                  autoFocus
                  size="lg"
                  className="h-9 gap-3 px-4 justify-between sm:min-w-32"
                  onClick={() => {
                    if (localCode === null) return;
                    runRefresh(localCode);
                  }}
                >
                  <span>{intl.formatMessage({ id: "assistCode.dialog.refreshConfirm" })}</span>
                  <span className="font-mono text-ui-base text-primary-foreground/60">⏎</span>
                </Button>
              </>
            ) : null}
            {phase === "refreshing" ? (
              <Button type="button" size="lg" disabled className="h-9 gap-2 px-4">
                <Loader2 className="size-4 animate-spin" />
                {intl.formatMessage({ id: "assistCode.dialog.refreshing" })}
              </Button>
            ) : null}
            {phase === "error" ? (
              <>
                <AssistDialogSecondaryButton
                  label={intl.formatMessage({ id: "common.close" })}
                  onClick={() => setOpen(false)}
                />
                <Button
                  type="button"
                  autoFocus
                  size="lg"
                  className="h-9 px-4"
                  // 列表为空说明是读取阶段失败，重试读取；否则是刷新失败，原地重刷。
                  onClick={() => {
                    if (machines.length === 0) loadCurrent();
                    else if (localCode !== null) runRefresh(localCode);
                  }}
                >
                  {intl.formatMessage({ id: "assistCode.dialog.retry" })}
                </Button>
              </>
            ) : null}
            {phase === "ready" || phase === "loading" ? (
              <AssistDialogSecondaryButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={() => setOpen(false)}
              />
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
