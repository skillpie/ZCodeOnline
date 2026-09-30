// 远程控制弹窗（specs/web-tunnel.md §5.9）：侧栏设置按钮左侧的图标按钮，Web 与桌面共用，
// 是「远程控制」的统一入口——左栏为远程链接操作区（本机/远端机器列表、添加/复制/切换/
// 刷新，内容超出滚动），右栏为 Bot Channel 渠道操作区（见 BotChannelPanel，可用时展示，
// 窄屏退化为上下堆叠）。本机（Web 经回环发现端点、桌面经 daemon 控制链的权威码）固定
// 第一项并带「本机」标签，权威发现的新码若与列表里带 local 标记的旧本机条目不同码
// （本机在别处换过码），由 store 原位并入而不是新增，避免重复的「我的ZCode」；兜底
// 回退码不打标记。「刷新」二次确认后轮换本机码，旧链接立即失效；其余条目支持改名
// （默认名 = <远程码>的ZCode）、「复制」「切换」与删除。
// 「切换」保存该链接为当前生效码并整页重连（Web reload 后走隧道 bootstrap；桌面由
// main.tsx 的 tunnelEntryActive 分支接管）；桌面端「切换」到本机条目等价于退出隧道模式
// 回到本地桌面（见 switchTo）。仅当远程码契约与 Bot Channel 至少一个可用时渲染本入口；
// 轮换权威所有者在宿主 Core 隧道运行时。
import { useState } from "react";
import { Link2, Loader2, MonitorSmartphone, Plus, XIcon } from "lucide-react";import { DEFAULT_TUNNEL_RELAY_URL, relayWebOrigin } from "@zcode/shared";
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
  clearStoredAssistCode,
  defaultAssistMachineName,
  loadAssistMachines,
  loadStoredAssistCode,
  removeAssistMachine,
  renameAssistMachine,
  replaceAssistMachineCode,
  saveStoredAssistCode,
  upsertAssistMachine,
  upsertLocalAssistMachine,
  type AssistMachine,
} from "@/assistMachineStore.js";
import { AssistMachineRowCard } from "@/AssistMachineRowCard.js";
import { AssistMachineAddForm } from "@/AssistMachineAddForm.js";
import { BotChannelPanel } from "@/BotChannelPanel.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type AssistDialogPhase = "loading" | "ready" | "refreshing" | "error";

/** 本机条目置顶，其余按登记顺序。 */
function orderMachines(list: AssistMachine[], localCode: string | null): AssistMachine[] {
  if (!localCode) return list;
  return [
    ...list.filter((machine) => machine.code === localCode),
    ...list.filter((machine) => machine.code !== localCode),
  ];
}

export function WorkspaceAssistCodeRefreshTrigger({
  className,
  isDesktop = false,
  botChannel = null,
}: {
  className?: string;
  /** 桌面端：分享链接用 relay 站点源（renderer origin 非网页域名）。 */
  isDesktop?: boolean;
  /** Bot Channel（移动端远程控制）可用时传入：弹窗右栏展示其渠道操作区（见 BotChannelPanel）。 */
  botChannel?: { workspacePath: string; workspaceIdentity?: string } | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const requestConfirmation = useConfirmDialog();
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

  // 远程码契约（getRemoteAssistCode/refreshRemoteAssistCode）与 Bot Channel 至少一个
  // 可用才渲染合并入口；两者都可用时弹窗为双栏（左=远程码操作区，右=Bot Channel）。
  const assistAvailable = typeof platform.refreshRemoteAssistCode === "function";
  if (!assistAvailable && !botChannel) {
    return null;
  }

  const getRemoteAssistCode = platform.getRemoteAssistCode?.bind(platform);
  const refreshRemoteAssistCode = platform.refreshRemoteAssistCode?.bind(platform);
  // 分享链接的站点源：Web 与 relay 同源直接取 location；桌面 renderer 的 origin 不是
  // 网页域名，用产品 relay 入口推导（relayWebOrigin 去掉 /relay 路径前缀）。
  const origin = isDesktop ? relayWebOrigin(DEFAULT_TUNNEL_RELAY_URL) : window.location.origin;

  const loadCurrent = () => {
    setPhase("loading");
    setErrorCode(null);
    setRotated(false);
    setActiveCode(loadStoredAssistCode());
    // 平台实现内部已做"宿主不可达 → 回退本地存储"的兜底；local 为空时仍可展示已登记
    // 的远程链接（仅缺本机条目与刷新能力）。
    const finish = (local: string | null, authoritative: boolean) => {
      // 本机条目默认名叫「我的ZCode」；曾被用户改过名的条目不会被覆盖。
      // 仅权威回环发现（expiresAt 非 null）才打本机标记并参与换码合并：兜底回退的
      // 存储码可能指向正在远控的其他机器，误标会让后续合并吃掉远端条目。
      if (local) {
        const localDefaultName = intl.formatMessage({ id: "assistCode.dialog.localDefaultName" });
        if (authoritative) upsertLocalAssistMachine(local, localDefaultName);
        else upsertAssistMachine(local, localDefaultName);
      }
      setLocalCode(local);
      setMachines(orderMachines(loadAssistMachines(), local));
      setPhase("ready");
    };
    if (!getRemoteAssistCode) {
      finish(null, false);
      return;
    }
    void getRemoteAssistCode()
      .then((result) => finish(result.code, result.expiresAt !== null))
      .catch((cause: unknown) => {
        if (loadAssistMachines().length > 0) {
          finish(null, false);
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
    setOpen(true);
    loadCurrent();
  };

  // 「刷新」二次确认走标准确认弹窗：确认后轮换本机码，旧链接立即失效。
  const confirmRefresh = async () => {
    if (localCode === null) return;
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "assistCode.dialog.refreshTitle" }),
      description: intl.formatMessage({ id: "assistCode.dialog.refreshWarning" }),
      confirmLabel: intl.formatMessage({ id: "assistCode.dialog.refreshConfirm" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (confirmed) runRefresh(localCode);
  };

  const runRefresh = (previousLocalCode: string) => {
    setPhase("refreshing");
    setErrorCode(null);
    void refreshRemoteAssistCode?.()
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
    // 桌面端「切换」到本机条目（权威打 local 标记的）= 退出隧道模式回本地桌面：
    // 清存储码后整页重载，由 main.tsx 的本地启动流接管。Web 的本机即当前页面，
    // 维持原语义（存码重载）。兜底回退码不打 local 标记，不会误触本机分支。
    const machine = machines.find((entry) => entry.code === code);
    if (isDesktop && machine?.local === true) {
      clearStoredAssistCode();
    } else {
      saveStoredAssistCode(code);
    }
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
  };

  // 删除走标准确认弹窗：仅移除本端登记的链接记录（不影响对方电脑）；当前连接目标
  // 的删除按钮已禁用，不会删掉正在使用的连接。
  const removeRow = async (code: string) => {
    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "assistCode.dialog.delete" }),
      description: intl.formatMessage({ id: "assistCode.dialog.deleteConfirm" }),
      confirmLabel: intl.formatMessage({ id: "assistCode.dialog.delete" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setMachines(orderMachines(removeAssistMachine(code), localCode));
  };

  // 远程码操作区卡片（对齐官方版布局）：卡片自带小标题，机器列表等操作在卡片内
  // 独立滚动——合并双栏时卡片高度跟随右栏（h-full），单栏时自然高度、整页滚动。
  const assistOperationsCard = assistAvailable ? (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-4 flex items-start gap-2">
        <Link2 className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "assistCode.dialog.section.title" })}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "assistCode.dialog.section.description" })}
          </p>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto">
        {/* min-w-0：列表作为 grid item 默认 min-width:auto，行内 code+按钮的
            固有宽度会把轨道撑出横向滚动条。 */}
        {machines.length > 0 ? (
          <div className="min-w-0 space-y-2">
            {rotated && phase === "ready" ? (
              <div className="text-ui-sm text-foreground-subtle">
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
                  // 桌面本机模式下「切换」到本机无意义（已在本地），置灰；本机行
                  // 退化为展示链接 + 复制 + 刷新，供把链接发到浏览器远程控制本机。
                  // 隧道模式下本机行「切换」= 切回本机（见 switchTo），保持可点。
                  switchDisabled={isDesktop && isLocal && activeCode === null}
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
                  onRequestRefresh={() => void confirmRefresh()}
                  onSwitch={() => switchTo(machine.code)}
                  onRemove={() => void removeRow(machine.code)}
                />
              );
            })}
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
      </div>
      {/* 添加入口固定在卡片底部（与右栏「机器人管理」同款样式），不随列表滚动。 */}
      <div className="mt-3 shrink-0">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full justify-center gap-2 enabled:cursor-pointer"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" />
          {intl.formatMessage({ id: "assistCode.dialog.add" })}
        </Button>
      </div>
    </section>
  ) : null;

  // 双栏合并布局（远程码操作区 + Bot Channel 都可用）；移动窄屏退化为上下堆叠。
  const mergedLayout = assistAvailable && botChannel !== null;

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
          className={cn(
            "max-h-[calc(100vh-6rem)] gap-5 rounded-2xl",
            // 双栏：弹窗高度刚好包住右栏（Bot Channel）的自然内容高度——左栏卡片在
            // sm 起绝对定位脱离文档流，不参与行高计算，列表超出卡片高度时在卡内滚动；
            // 仅在窗口过矮超出 max-h 时才裁切。单栏维持整页滚动。
            // 48rem 加宽 1/8：54rem，容纳左栏链接列表 + 右栏 Bot Channel 两列。
            mergedLayout
              ? "overflow-y-auto sm:max-h-[calc(100vh-6rem)] sm:max-w-[54rem] sm:overflow-hidden"
              : "overflow-y-auto sm:max-w-lg",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: 弹窗贴近桌面窗口顶部显示，默认 close 在 Electron drag 区里容易
            // 点不中，改显式关闭按钮并标 no-drag 保证右上角关闭稳定命中。
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={() => setOpen(false)}
          >
            <XIcon />
            <span className="sr-only">
              {intl.formatMessage({ id: "common.close" })}
            </span>
          </Button>
          <DialogHeader className="flex-col items-start gap-3 sm:flex-row sm:items-center">
            {/* 图标徽标（对齐官方版布局）：远程控制的统一视觉锚点。 */}
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-primary">
              <MonitorSmartphone className="size-6" />
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-ui-lg font-semibold text-foreground">
                {intl.formatMessage({ id: "assistCode.dialog.title" })}
              </DialogTitle>
              <DialogDescription className="pt-0.5 text-ui-base/relaxed text-foreground-subtle">
                {intl.formatMessage({ id: "assistCode.dialog.description" })}
              </DialogDescription>
            </div>
          </DialogHeader>

          {mergedLayout ? (
            // 左栏卡片绝对定位脱离文档流：行高完全由右栏（Bot Channel）内容决定，
            // 弹窗高度刚好包住右栏；左栏列表超出卡片高度时在卡内滚动。
            // 比例对齐官方版：左栏约 3/5、右栏约 2/5（左栏链接列表内容更多）。
            <div className="relative grid gap-4 sm:grid-cols-[3fr_2fr]">
              <div className="min-w-0 sm:absolute sm:inset-y-0 sm:left-0 sm:w-[calc((100%-1rem)*0.6)]">
                {assistOperationsCard}
              </div>
              <div className="sm:col-start-2 sm:row-start-1">
                <BotChannelPanel
                  workspacePath={botChannel.workspacePath}
                  workspaceIdentity={botChannel.workspaceIdentity}
                />
              </div>
            </div>
          ) : (
            <>
              {assistOperationsCard}
              {/* 仅 Bot Channel 可用（无远程码契约的平台）：单栏只展示渠道操作区。 */}
              {botChannel && !assistAvailable ? (
                <BotChannelPanel
                  workspacePath={botChannel.workspacePath}
                  workspaceIdentity={botChannel.workspaceIdentity}
                />
              ) : null}
            </>
          )}

          {/* footer 只承载瞬态操作（刷新中/错误重试）；「添加远程链接」是独立弹窗、
              入口固定在左栏卡片底部，关闭统一走右上角 X，ready/loading 态不渲染 footer。 */}
          {phase === "refreshing" || phase === "error" ? (
            <DialogFooter className="gap-2">
              {phase === "refreshing" ? (
                <Button type="button" size="lg" disabled className="h-9 gap-2 px-4">
                  <Loader2 className="size-4 animate-spin" />
                  {intl.formatMessage({ id: "assistCode.dialog.refreshing" })}
                </Button>
              ) : null}
              {phase === "error" ? (
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
              ) : null}
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
      {/* 添加远程链接：独立弹窗（表单草稿态在 AssistMachineAddForm 内部，关闭即重置；
          提交成功后入库并关闭，与卡片内列表共用同一套入库逻辑）。 */}
      <Dialog
        open={adding}
        onOpenChange={(nextOpen) => {
          if (phase === "refreshing") return;
          setAdding(nextOpen);
        }}
      >
        <DialogContent showCloseButton={false} className="gap-4 sm:max-w-md">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "assistCode.dialog.add" })}
            </DialogTitle>
          </DialogHeader>
          <AssistMachineAddForm
            localCode={localCode}
            existingCodes={machines.map((machine) => machine.code)}
            onSubmit={(code, name) => {
              upsertAssistMachine(code);
              if (name) renameAssistMachine(code, name);
              setMachines(orderMachines(loadAssistMachines(), localCode));
              closeAddForm();
            }}
            onCancel={closeAddForm}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
