// 隧道应用根（specs/web-tunnel.md §3.3）：主界面常驻渲染——未连接时用"挂起型 stub 服务"
// 驱动真实 UI（所有 RPC 永不返回 → 界面呈加载态），顶层盖不可关闭的连接引导模态；
// 连接成功换入真实服务（Root 按 key 重挂载），断开则模态重现、UI 回到加载态。
// 远程码（§5.9）路径：浏览器存储的 16 位码优先直连目标机器；码失效（已在别处刷新）
// 时清存储回退本机链路，保证轮换后旧浏览器不被锁死。地址栏始终不出现码本身。
import { useCallback, useEffect, useRef, useState } from "react";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { connectViaProtocol } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { DEFAULT_TUNNEL_RELAY_URL } from "@zcode/shared";
import { TunnelConnectError, connectTunnelServices, type TunnelBootstrap } from "./tunnelSocket.js";
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
import { ConnectionGateCard } from "./TunnelGateScreen.js";

export type TunnelServices = ReturnType<typeof connectViaProtocol>;

const t = (zhText: string, enText: string) => (/^zh\b/i.test(navigator.language) ? zhText : enText);

// ---- 门禁 UI 状态 ----

type GateStatus = "idle" | "pairing" | "connecting" | "disconnected";

interface GateState {
  visible: boolean;
  status: GateStatus;
  error: string | null;
  needsLogin: boolean;
}

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
  const [gate, setGate] = useState<GateState>({
    visible: true,
    status: "idle",
    error: null,
    needsLogin: false,
  });
  // 连接代际：旧连接的迟到 onClose 不得影响新连接的状态。
  const activeConnRef = useRef(0);

  const patchGate = useCallback((patch: Partial<GateState>) => {
    setGate((current) => ({ ...current, ...patch }));
  }, []);

  const connectWithSession = useCallback(
    async (session: TunnelSession) => {
      const seq = activeConnRef.current + 1;
      activeConnRef.current = seq;
      patchGate({ status: "connecting", error: null });
      try {
        const connected = await connectTunnelServices({
          relayUrl: session.relayUrl,
          hostId: session.hostId,
          psk: session.psk,
          sessionCredential: session.sessionCredential,
          onClose: () => {
            if (activeConnRef.current !== seq) return;
            // 断开：模态重现，UI 回到骨架态（Root 换回骨架重挂载）。
            document.title = "ZCode Online";
            setServices(null);
            setBootstrap(undefined);
            patchGate({ visible: true, status: "disconnected" });
          },
        });
        if (activeConnRef.current !== seq) {
          connected.transport.close();
          return;
        }
        document.title = "ZCode Online";
        // 地址栏保持干净域名（specs/web-tunnel.md §5.9）：远程码只存浏览器本地，
        // 不再回写 /<码> 形式的 URL，避免投屏/截图/历史记录泄露长期凭证。
        setServices(connected.services);
        setBootstrap(connected.bootstrap);
        patchGate({ visible: false, status: "idle", error: null, needsLogin: false });
      } catch (cause) {
        if (activeConnRef.current !== seq) return;
        setServices(null);
        patchGate({ visible: true, status: "idle" });
        if (cause instanceof TunnelConnectError && cause.code !== "network") {
          // 凭证类失败：会话已不可用，清掉让用户重新配对。
          clearTunnelSession();
        }
        const message =
          cause instanceof Error ? cause.message : cause instanceof Object ? String(cause) : "";
        patchGate({ error: message });
      }
    },
    [patchGate],
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
        patchGate({ status: "idle" });
        if (cause instanceof TunnelPairingError && cause.code === "auth") {
          patchGate({ needsLogin: true });
          return;
        }
        patchGate({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    [connectWithSession, getAccessToken, patchGate],
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
        patchGate({ visible: true, status: "idle", error: notice });
        return;
      }
      patchGate({ visible: true, status: "pairing", error: null });
      try {
        const session = await pairWithCode({
          pairingUrl: discovery.pairingUrl,
          accessToken: getAccessToken(),
        });
        await connectWithSession(session);
      } catch (cause) {
        patchGate({ status: "idle" });
        if (cause instanceof TunnelPairingError && cause.code === "auth") {
          patchGate({ needsLogin: true });
          return;
        }
        patchGate({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    [connectWithSession, getAccessToken, patchGate],
  );

  // 远程码直连（码即凭证）：兑换一次性票据 → 隧道数据面。码失效（invalid，说明已在
  // 别处被刷新/解绑）时清掉存储并回退本机链路；其他失败保留存储，断开态可一键重连。
  const connectWithAssistCode = useCallback(
    async (code: string) => {
      const seq = activeConnRef.current + 1;
      activeConnRef.current = seq;
      patchGate({ visible: true, status: "connecting", error: null });
      try {
        const redeemed = await redeemAssistCode(code);
        const connected = await connectTunnelServices({
          relayUrl: DEFAULT_TUNNEL_RELAY_URL,
          hostId: redeemed.hostId,
          psk: redeemed.psk,
          connectToken: redeemed.connectToken,
          onClose: () => {
            if (activeConnRef.current !== seq) return;
            // 断开（被控电脑下线/网络断）：码仍长期有效，重连即可。
            document.title = "ZCode Online";
            setServices(null);
            setBootstrap(undefined);
            patchGate({
              visible: true,
              status: "disconnected",
              error: t(
                "远程电脑当前不在线，恢复后点「重新连接」。",
                "The remote machine is offline. Click Reconnect once it's back.",
              ),
            });
          },
        });
        if (activeConnRef.current !== seq) {
          connected.transport.close();
          return;
        }
        document.title = "ZCode Online";
        setServices(connected.services);
        setBootstrap(connected.bootstrap);
        patchGate({ visible: false, status: "idle", error: null, needsLogin: false });
      } catch (cause) {
        if (activeConnRef.current !== seq) return;
        setServices(null);
        setBootstrap(undefined);
        const invalidCode = cause instanceof AssistRedeemError && cause.kind === "invalid";
        if (invalidCode) clearStoredAssistCode();
        // 断开态（含重连按钮）承接兑换/握手的可重试失败；失效码则回退本机链路兜底。
        if (!invalidCode) {
          patchGate({
            visible: true,
            status: "disconnected",
            error: cause instanceof Error ? cause.message : String(cause),
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
    [connectWithoutAssistCode, patchGate],
  );

  const handleReconnect = useCallback(() => {
    const storedCode = loadStoredAssistCode();
    if (storedCode) {
      void connectWithAssistCode(storedCode);
      return;
    }
    void connectWithoutAssistCode(null);
  }, [connectWithAssistCode, connectWithoutAssistCode]);

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

      {gate.visible ? (
        // 不可关闭的连接引导模态：连上本机前常驻顶层，断开时重现。
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-lg">
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
