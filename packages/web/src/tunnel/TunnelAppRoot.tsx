// 隧道应用根（specs/web-tunnel.md §3.3）：主界面常驻渲染——未连接时展示与主界面同构的
// 静态骨架，连接在后台进行（刷新/首开不弹「连接到你的电脑」模态，底部只挂细状态条）；
// 仅定局失败（不可重试错误、需登录、自动重连耗尽、本机无可连对象）才弹出连接引导模态。
// 连接成功换入真实服务（Root 按 key 重挂载），断开则回到骨架并后台自动重连。
// 远程码（§5.9）路径：浏览器存储的 16 位码优先直连目标机器；码失效（已在别处刷新）
// 时清存储回退本机链路，保证轮换后旧浏览器不被锁死。地址栏始终不出现码本身。
import { useCallback, useEffect, useRef, useState } from "react";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import {
  createAutoReconnect,
  isRetryableTunnelConnectError,
  TunnelConnectError,
  connectTunnelServices,
  type TunnelBootstrap,
} from "@zcode/client";
import type { connectViaProtocol } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { DEFAULT_TUNNEL_RELAY_URL, TUNNEL_CONSTANTS } from "@zcode/shared";
import {
  AssistRedeemError,
  clearStoredAssistCode,
  loadStoredAssistCode,
  redeemAssistCode,
} from "./assistSession.js";
import {
  TunnelPairingError,
  clearTunnelSession,
  discoverLocalPairing,
  loadTunnelSession,
  pairWithCode,
  type TunnelSession,
} from "./tunnelSession.js";
import { initialGateState, nextGateState, type GateEvent, type GateState } from "./gateState.js";
import { ConnectionGateCard } from "./TunnelGateScreen.js";

export type TunnelServices = ReturnType<typeof connectViaProtocol>;

const t = (zhText: string, enText: string) => (/^zh\b/i.test(navigator.language) ? zhText : enText);

// 自动重连窗口：6 次（1+2+4+8+16+30 ≈ 61s）覆盖 relay 重启空窗（秒级）+ 宿主退避重连
// （最长 reconnectMaxMs）的典型恢复时长；超过后交还手动重连，保留换机重新配对的出口。
const AUTO_RECONNECT_MAX_ATTEMPTS = 6;

/** 未连接时的静态应用骨架：与主界面同构的空态，视觉占位而非假交互。 */
export function DisconnectedAppSkeleton() {
  const isZh = /^zh\b/i.test(navigator.language);
  return (
    <div className="flex h-full w-full select-none bg-background text-foreground" aria-hidden>
      <aside className="hidden w-64 shrink-0 flex-col gap-2 border-r border-border p-3 md:flex">
        <div className="px-2 py-1 text-ui-xs font-medium text-foreground-subtle">ZCode</div>
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs">
          {isZh ? "新建任务" : "New task"}
        </div>
        {["搜索", "自动化", "插件市场", "技能市场"].map((label) => (
          <div key={label} className="rounded-lg px-3 py-2 text-ui-xs text-foreground-subtle">
            {isZh ? label : label === "搜索" ? "Search" : label}
          </div>
        ))}
        <div className="mt-4 px-2 text-ui-xs font-medium text-foreground-subtle">
          {isZh ? "项目" : "Projects"}
        </div>
        {[64, 52, 58, 44].map((width, index) => (
          <div key={index} className="h-4 rounded bg-surface" style={{ width: `${width}%` }} />
        ))}
      </aside>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="text-ui-lg font-medium">
          {isZh ? "下午好呀，接下来交给我吧" : "Good afternoon — what shall we build?"}
        </div>
        <div className="w-full max-w-xl rounded-xl border border-border bg-surface px-4 py-3 text-ui-xs text-foreground-subtle">
          {isZh
            ? "向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力"
            : "Ask ZCode — @ for context, / for commands"}
        </div>
      </main>
    </div>
  );
}

export function TunnelAppRoot({
  platform,
  getAccessToken,
  startLogin,
}: {
  platform: IPlatformService;
  getAccessToken: () => string | null;
  startLogin: () => void;
}) {
  const [services, setServices] = useState<TunnelServices | null>(null);
  const [bootstrap, setBootstrap] = useState<TunnelBootstrap | undefined>(undefined);
  // 初始不弹门禁：刷新/首开直接展示骨架主界面，连接在后台进行（见 gateState.ts）。
  const [gate, setGate] = useState<GateState>(initialGateState);
  // 连接代际：旧连接的迟到 onClose 不得影响新连接的状态。
  const activeConnRef = useRef(0);

  const dispatchGate = useCallback((event: GateEvent) => {
    setGate((current) => nextGateState(current, event));
  }, []);

  // 自动重连调度器（唯一所有者是本组件）。重试动作经 retryDispatchRef 间接引用连接链，
  // 打断"连接链引用调度器、调度器引用连接链"的 useCallback 循环依赖。
  const autoReconnectRef = useRef<ReturnType<typeof createAutoReconnect> | null>(null);
  const retryDispatchRef = useRef<() => void>(() => {});
  if (autoReconnectRef.current === null) {
    autoReconnectRef.current = createAutoReconnect({
      maxAttempts: AUTO_RECONNECT_MAX_ATTEMPTS,
      initialMs: TUNNEL_CONSTANTS.reconnectInitialMs,
      maxMs: TUNNEL_CONSTANTS.reconnectMaxMs,
      onRetry: () => retryDispatchRef.current(),
      onGiveUp: () =>
        dispatchGate({
          kind: "gateError",
          status: "disconnected",
          message: t(
            "自动重连未成功，请点击「重新连接」。",
            "Automatic reconnection failed. Click Reconnect to try again.",
          ),
        }),
    });
  }

  // 断开/失败后的统一入口：后台重连（骨架 + 底部状态条，不弹模态），再由调度器按退避序列重跑连接链。
  const scheduleReconnect = useCallback(() => {
    dispatchGate({
      kind: "retryScheduled",
      message: t("连接已断开，正在自动重连…", "Connection lost. Reconnecting…"),
    });
    autoReconnectRef.current?.schedule();
  }, [dispatchGate]);

  const connectWithSession = useCallback(
    async (session: TunnelSession) => {
      const seq = activeConnRef.current + 1;
      activeConnRef.current = seq;
      dispatchGate({ kind: "connectStart" });
      // 握手完成前的断开（含 fail() 主动 close 触发的 onClose）由 catch 统一做重试决策；
      // onClose 只接管已建立的连接，避免协议类失败被误排入自动重试。
      let established = false;
      try {
        const connected = await connectTunnelServices({
          relayUrl: session.relayUrl,
          hostId: session.hostId,
          psk: session.psk,
          sessionCredential: session.sessionCredential,
          onClose: () => {
            if (activeConnRef.current !== seq) return;
            // 断开：UI 回到骨架态（Root 换回骨架重挂载），scheduleReconnect 后台重连。
            document.title = "ZCode Online";
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
        document.title = "ZCode Online";
        // 连接成功：清空重连计数，后续断开从第 1 次退避重新开始。
        autoReconnectRef.current?.clear();
        // 地址栏保持干净域名（specs/web-tunnel.md §5.9）：远程码只存浏览器本地，
        // 不再回写 /<码> 形式的 URL，避免投屏/截图/历史记录泄露长期凭证。
        setServices(connected.services);
        setBootstrap(connected.bootstrap);
        dispatchGate({ kind: "connectSuccess" });
      } catch (cause) {
        if (activeConnRef.current !== seq) return;
        setServices(null);
        if (
          cause instanceof TunnelConnectError &&
          (cause.code === "invalidSessionCredential" || cause.code === "connectTokenInvalid")
        ) {
          // 凭证类失败（relay 重启丢失内存态或会话过期）：旧会话已不可用，清掉让
          // 重连链重新配对——同机浏览器经本地发现零输入完成，远程设备停在手动门禁。
          clearTunnelSession();
        }
        if (isRetryableTunnelConnectError(cause)) {
          // 网络空窗/宿主暂未重新注册/会话待重新配对：退避重试。不再像旧逻辑那样对
          // hostOffline 也清会话——宿主短暂离线后原会话仍有效，远程设备无需重新扫码。
          scheduleReconnect();
          return;
        }
        const message =
          cause instanceof Error ? cause.message : cause instanceof Object ? String(cause) : "";
        dispatchGate({ kind: "gateError", status: "idle", message });
      }
    },
    [dispatchGate, scheduleReconnect],
  );

  const handlePairSubmit = useCallback(
    async (pairingUrl: string) => {
      try {
        const session = await pairWithCode({
          pairingUrl,
          accessToken: getAccessToken(),
        });
        await connectWithSession(session);
      } catch (cause) {
        if (cause instanceof TunnelPairingError && cause.code === "auth") {
          dispatchGate({ kind: "needsLogin" });
          return;
        }
        dispatchGate({
          kind: "gateError",
          status: "idle",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [connectWithSession, getAccessToken, dispatchGate],
  );

  // 无远程码时的既有连接链：已存会话直连 → 本地发现（宿主在本机时零输入自动配对）→ 门禁。
  // notice 非空时展示在门禁上（远程码失效回退场景，向用户解释为什么没连上码对应的机器）。
  const connectWithoutAssistCode = useCallback(
    async (notice: string | null) => {
      const savedSession = loadTunnelSession();
      if (savedSession) {
        await connectWithSession(savedSession);
        return;
      }
      const discovery = await discoverLocalPairing();
      if (!discovery) {
        // 本机无可连对象（宿主未装/不在本机）：定局失败，弹出引导门禁。
        dispatchGate({ kind: "gateError", status: "idle", message: notice });
        return;
      }
      dispatchGate({ kind: "pairingStart" });
      try {
        const session = await pairWithCode({
          pairingUrl: discovery.pairingUrl,
          accessToken: getAccessToken(),
        });
        await connectWithSession(session);
      } catch (cause) {
        if (cause instanceof TunnelPairingError && cause.code === "auth") {
          dispatchGate({ kind: "needsLogin" });
          return;
        }
        dispatchGate({
          kind: "gateError",
          status: "idle",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [connectWithSession, getAccessToken, dispatchGate],
  );

  // 远程码直连（码即凭证）：兑换一次性票据 → 隧道数据面。码失效（invalid，说明已在
  // 别处被刷新/解绑）时清掉存储并回退本机链路；其他失败保留存储，断开态可一键重连。
  const connectWithAssistCode = useCallback(
    async (code: string) => {
      const seq = activeConnRef.current + 1;
      activeConnRef.current = seq;
      dispatchGate({ kind: "connectStart" });
      // 同 connectWithSession：握手前的断开由 catch 统一决策，onClose 只接管已建立的连接。
      let established = false;
      try {
        const redeemed = await redeemAssistCode(code);
        const connected = await connectTunnelServices({
          relayUrl: DEFAULT_TUNNEL_RELAY_URL,
          hostId: redeemed.hostId,
          psk: redeemed.psk,
          connectToken: redeemed.connectToken,
          onClose: () => {
            if (activeConnRef.current !== seq) return;
            // 断开（被控电脑下线/网络断/relay 重启）：码长期有效，自动重连即可恢复。
            document.title = "ZCode Online";
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
        document.title = "ZCode Online";
        autoReconnectRef.current?.clear();
        setServices(connected.services);
        setBootstrap(connected.bootstrap);
        dispatchGate({ kind: "connectSuccess" });
      } catch (cause) {
        if (activeConnRef.current !== seq) return;
        setServices(null);
        setBootstrap(undefined);
        const invalidCode = cause instanceof AssistRedeemError && cause.kind === "invalid";
        if (invalidCode) clearStoredAssistCode();
        // 断开态（含重连按钮）承接兑换/握手的可重试失败；失效码则回退本机链路兜底。
        if (!invalidCode) {
          if (isRetryableTunnelConnectError(cause)) {
            scheduleReconnect();
            return;
          }
          dispatchGate({
            kind: "gateError",
            status: "disconnected",
            message: cause instanceof Error ? cause.message : String(cause),
          });
          return;
        }
        await connectWithoutAssistCode(
          t(
            "存储的远程码已失效（可能已被刷新）；要连接这台电脑，请打开它最新的远程码链接。",
            "The stored assist code is no longer valid (it may have been rotated); open the machine's newest code link to reach it.",
          ),
        );
      }
    },
    [connectWithoutAssistCode, dispatchGate, scheduleReconnect],
  );

  const handleReconnect = useCallback(() => {
    // 手动重连 = 重新开始完整的自动重连窗口（清计数与待执行定时器）。
    autoReconnectRef.current?.clear();
    const storedCode = loadStoredAssistCode();
    if (storedCode) {
      void connectWithAssistCode(storedCode);
      return;
    }
    void connectWithoutAssistCode(null);
  }, [connectWithAssistCode, connectWithoutAssistCode]);

  // 自动重试的分派与手动重连同链路（远程码优先，其次已存会话/本地发现重配对），
  // 但不清调度器状态——退避计数必须跨多次重试累积，清零会让窗口永不耗尽。
  retryDispatchRef.current = () => {
    const storedCode = loadStoredAssistCode();
    if (storedCode) {
      void connectWithAssistCode(storedCode);
      return;
    }
    void connectWithoutAssistCode(null);
  };

  // 挂载：存储的远程码优先（最后传入的码 = 用户最近一次的连接意图）；否则走本机链路。
  useEffect(() => {
    const storedCode = loadStoredAssistCode();
    if (storedCode) {
      void connectWithAssistCode(storedCode);
      return;
    }
    void connectWithoutAssistCode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 生命周期仅挂载时执行一次
  }, []);

  // 卸载清理：组件销毁后不再让存活的定时器触发连接链。
  useEffect(() => {
    return () => {
      autoReconnectRef.current?.clear();
    };
  }, []);

  const hostWorkspace = services ? bootstrap?.workspaces[0] : undefined;

  return (
    <div className="relative h-dvh w-screen">
      {services ? (
        <AppErrorBoundary>
          <ZCodeIntlProvider
            settingService={services.settingService}
            broadcastService={services.broadcastService}
          >
            <Root
              key={`tunnel-conn-${activeConnRef.current}`}
              services={services}
              platform={platform}
              suppressAccountOnboarding
              suppressJwtInvalidReload
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
              loadZcodeSsoJwtToken={async () => getAccessToken()}
              {...(hostWorkspace
                ? {
                    initialWorkspaceAbsPath: hostWorkspace.path,
                    ...(hostWorkspace.workspaceIdentity
                      ? { initialWorkspaceIdentity: hostWorkspace.workspaceIdentity }
                      : {}),
                  }
                : {})}
            />
          </ZCodeIntlProvider>
        </AppErrorBoundary>
      ) : (
        // 未连接：静态应用骨架（与主界面同构的空态），连接后换入真实应用。
        <DisconnectedAppSkeleton />
      )}

      {services === null && !gate.visible ? (
        // 后台连接状态条：刷新/断线期间主界面（骨架）不被模态遮挡，仅以细条反馈进度；
        // 定局失败弹出上方门禁后即被其取代（两者互斥）。
        <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 shadow-lg">
            <span className="size-2 animate-pulse rounded-full bg-amber-500" />
            <span className="text-ui-sm text-foreground-subtle">
              {t("正在连接你的电脑…", "Connecting to your machine…")}
            </span>
          </div>
        </div>
      ) : null}

      {gate.visible ? (
        // 不可关闭的连接引导模态：仅在定局失败/需要用户操作时弹出（见 gateState.ts）。
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          {/* max-w-lg（32rem）加宽 1/6：32rem * 7/6 ≈ 37.333rem ≈ 597px。 */}
          <div className="w-full max-w-[37.333rem]">
            <ConnectionGateCard
              status={gate.status}
              error={gate.error}
              needsLogin={gate.needsLogin}
              onReconnect={handleReconnect}
              onStartLogin={startLogin}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
