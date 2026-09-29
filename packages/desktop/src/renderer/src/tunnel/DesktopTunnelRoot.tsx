// 桌面远程控制隧道模式（整窗切换，对齐 Web 版 specs/web-tunnel.md §5.9 的「切换」语义）：
// renderer 启动时 localStorage 存有远程码即进入本组件——用码向 relay 兑换一次性连接
// 票据（经 platform.redeemAssistCode → main 进程代理，绕开 renderer CORS），再经
// @zcode/client 的共享隧道传输建立端到端加密通道，远端 services 驱动同一套 Root UI，
// 整窗呈现远端机器的 ZCode（会话/workspace 均为远端事实）。
// 「切回本机」= 清存储码 + location.reload()，回到本地 MessagePort 启动流（main.tsx）。
// 码失效（已被对方刷新）不自动重载：给出明确反馈，由用户点击「切回本机」。
// 门禁阶段未挂 ZCodeIntlProvider，与 Web TunnelGateScreen 一样用 navigator.language 内联双语。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  assertRedeemResult,
  connectTunnelServices,
  createAutoReconnect,
  isRetryableTunnelConnectError,
  AssistRedeemError,
  type TunnelBootstrap,
} from "@zcode/client";
import type { connectViaProtocol } from "@zcode/client";
import { DEFAULT_TUNNEL_RELAY_URL, TUNNEL_CONSTANTS } from "@zcode/shared";
import type { IPlatformService, Locale } from "@zcode/shared";
import { Root, ZCodeIntlProvider } from "@zcode/ui";
import { clearStoredAssistCode, loadStoredAssistCode } from "@zcode/ui/assist-machine-store";

type DesktopTunnelServices = ReturnType<typeof connectViaProtocol>;

// 与 Web 版一致的重连窗口：覆盖 relay 重启空窗（秒级）+ 宿主退避重连的典型恢复时长。
const AUTO_RECONNECT_MAX_ATTEMPTS = 6;

type GatePhase = "connecting" | "connected" | "reconnecting" | "failed" | "invalid";

interface GateState {
  phase: GatePhase;
  error: string | null;
}

const zh = (): boolean => /^zh\b/i.test(navigator.language);

/** 门禁遮罩：连接中/重连中为不可关闭的进度态；失败/失效给出显式出口按钮。 */
function TunnelGateCard({
  phase,
  error,
  onReconnect,
  onReturnToLocal,
}: {
  phase: Exclude<GatePhase, "connected">;
  error: string | null;
  onReconnect: () => void;
  onReturnToLocal: () => void;
}) {
  const t = (zhText: string, enText: string) => (zh() ? zhText : enText);
  const busy = phase === "connecting" || phase === "reconnecting";
  const title =
    phase === "invalid"
      ? t("远程码已失效", "Assist code is no longer valid")
      : phase === "reconnecting"
        ? t("连接已断开，正在自动重连…", "Connection lost. Reconnecting…")
        : t("正在连接远程机器…", "Connecting to the remote machine…");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <section className="w-full max-w-[37.333rem] rounded-xl border border-card-border bg-card p-5 shadow-xl">
        <div className="flex items-center gap-3">
          {busy ? (
            // CSS 转圈：桌面 renderer 不为门禁单独引入图标依赖。
            <div
              role="status"
              className="size-4 shrink-0 animate-spin rounded-full border-2 border-foreground-subtle border-t-transparent"
            />
          ) : null}
          <h1 className="text-ui-lg font-medium">{title}</h1>
        </div>
        {phase === "invalid" ? (
          <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
            {t(
              "存储的远程码已失效（可能已在对方设备上刷新）；可重新输入最新远程码，或切回本机。",
              "The stored assist code is no longer valid (it may have been rotated on the other machine); enter its newest code or return to this machine.",
            )}
          </p>
        ) : null}
        {error !== null ? (
          <p className="mt-3 break-all text-ui-base/relaxed text-destructive">{error}</p>
        ) : null}
        {!busy ? (
          <div className="mt-4 flex items-center justify-end gap-3">
            {phase !== "invalid" ? (
              <button
                type="button"
                autoFocus
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground hover:bg-surface-hover"
                onClick={onReconnect}
              >
                {t("重新连接", "Reconnect")}
              </button>
            ) : null}
            <button
              type="button"
              autoFocus={phase === "invalid"}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground hover:bg-surface-hover"
              onClick={onReturnToLocal}
            >
              {t("切回本机", "Use this machine")}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function DesktopTunnelRoot({
  platform,
  isMacDesktop,
  isWindowsDesktop,
  initialLocale,
  resolveSystemLocale,
}: {
  platform: IPlatformService;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  initialLocale?: Locale;
  resolveSystemLocale?: () => Promise<Locale>;
}) {
  const [services, setServices] = useState<DesktopTunnelServices | null>(null);
  const [bootstrap, setBootstrap] = useState<TunnelBootstrap | undefined>(undefined);
  const [gate, setGate] = useState<GateState>({ phase: "connecting", error: null });
  // 连接代际：旧连接的迟到 onClose 不得影响新连接的状态。
  const activeConnRef = useRef(0);

  const patchGate = useCallback((patch: Partial<GateState>) => {
    setGate((current) => ({ ...current, ...patch }));
  }, []);

  /** 切回本机：清存储码后整页重载，main.tsx 的本地启动流接管。 */
  const returnToLocal = useCallback(() => {
    clearStoredAssistCode();
    window.location.reload();
  }, []);

  // 自动重连调度器（唯一所有者是本组件）。重试动作经 retryDispatchRef 间接引用连接链，
  // 打断"连接链引用调度器、调度器引用连接链"的循环依赖（同 Web TunnelAppRoot）。
  const autoReconnectRef = useRef<ReturnType<typeof createAutoReconnect> | null>(null);
  const retryDispatchRef = useRef<() => void>(() => {});
  if (autoReconnectRef.current === null) {
    autoReconnectRef.current = createAutoReconnect({
      maxAttempts: AUTO_RECONNECT_MAX_ATTEMPTS,
      initialMs: TUNNEL_CONSTANTS.reconnectInitialMs,
      maxMs: TUNNEL_CONSTANTS.reconnectMaxMs,
      onRetry: () => retryDispatchRef.current(),
      onGiveUp: () =>
        patchGate({
          phase: "failed",
          error: zh()
            ? "自动重连未成功，请点击「重新连接」。"
            : "Automatic reconnection failed. Click Reconnect to try again.",
        }),
    });
  }

  // 断开/失败后的统一入口：门禁切到重连中，再由调度器按退避序列重跑连接链。
  const scheduleReconnect = useCallback(() => {
    patchGate({ phase: "reconnecting", error: null });
    autoReconnectRef.current?.schedule();
  }, [patchGate]);

  const connectWithStoredCode = useCallback(async () => {
    const seq = activeConnRef.current + 1;
    activeConnRef.current = seq;
    const storedCode = loadStoredAssistCode();
    // 码在门禁停留期间被「切回本机」清掉的竞态：无码即回本地。
    if (!storedCode) {
      returnToLocal();
      return;
    }
    patchGate({ phase: "connecting", error: null });
    // 握手完成前的断开由 catch 统一重试决策；onClose 只接管已建立的连接。
    let established = false;
    try {
      if (typeof platform.redeemAssistCode !== "function") {
        throw new AssistRedeemError("Assist redeem is unavailable on this platform", "generic");
      }
      const redeemed = assertRedeemResult(await platform.redeemAssistCode(storedCode));
      const connected = await connectTunnelServices({
        relayUrl: DEFAULT_TUNNEL_RELAY_URL,
        hostId: redeemed.hostId,
        psk: redeemed.psk,
        connectToken: redeemed.connectToken,
        onClose: () => {
          if (activeConnRef.current !== seq) return;
          // 断开（被控电脑下线/网络断/relay 重启）：码长期有效，自动重连即可恢复。
          setServices(null);
          setBootstrap(undefined);
          if (established) scheduleReconnect();
        },
      });
      if (activeConnRef.current !== seq) {
        connected.transport.close();
        return;
      }
      established = true;
      // 连接成功：清空重连计数，后续断开从第 1 次退避重新开始。
      autoReconnectRef.current?.clear();
      setServices(connected.services);
      setBootstrap(connected.bootstrap);
      patchGate({ phase: "connected", error: null });
    } catch (cause) {
      if (activeConnRef.current !== seq) return;
      setServices(null);
      setBootstrap(undefined);
      if (isRetryableTunnelConnectError(cause)) {
        scheduleReconnect();
        return;
      }
      // invalid（码已被对方刷新）不自动重载，给用户明确反馈与出口；其余失败停门禁。
      patchGate({
        phase:
          cause instanceof AssistRedeemError && cause.kind === "invalid" ? "invalid" : "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [patchGate, platform, returnToLocal, scheduleReconnect]);

  const handleReconnect = useCallback(() => {
    // 手动重连 = 重新开始完整的自动重连窗口（清计数与待执行定时器）。
    autoReconnectRef.current?.clear();
    void connectWithStoredCode();
  }, [connectWithStoredCode]);

  // 自动重试的分派与手动重连同链路；不清调度器状态——退避计数须跨重试累积。
  retryDispatchRef.current = () => {
    void connectWithStoredCode();
  };

  // 挂载即连接；卸载清理存活定时器。
  useEffect(() => {
    void connectWithStoredCode();
    return () => {
      autoReconnectRef.current?.clear();
    };
    // 生命周期仅挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hostWorkspace = services ? bootstrap?.workspaces[0] : undefined;

  return (
    <div className="relative h-dvh w-screen">
      <ZCodeIntlProvider
        settingService={services?.settingService}
        broadcastService={services?.broadcastService}
        initialLocale={initialLocale}
        resolveSystemLocale={resolveSystemLocale}
      >
        {services ? (
          <Root
            key={`desktop-tunnel-conn-${activeConnRef.current}`}
            services={services}
            platform={platform}
            isDesktop
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            // 远端会话持久化天然在远端 daemon；不参与本地 tab 恢复，避免状态串扰。
            restoreSession={false}
            // 隧道内不嵌套 SSH/WSL 远程向导（对齐 Web 版），且嵌入浏览器不可用。
            allowRemoteWorkspace={false}
            suppressAccountOnboarding
            suppressJwtInvalidReload
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            {...(hostWorkspace
              ? {
                  initialWorkspaceAbsPath: hostWorkspace.path,
                  ...(hostWorkspace.workspaceIdentity
                    ? { initialWorkspaceIdentity: hostWorkspace.workspaceIdentity }
                    : {}),
                }
              : {})}
          />
        ) : null}
      </ZCodeIntlProvider>
      {gate.phase !== "connected" ? (
        <TunnelGateCard
          phase={gate.phase}
          error={gate.error}
          onReconnect={handleReconnect}
          onReturnToLocal={returnToLocal}
        />
      ) : null}
    </div>
  );
}
