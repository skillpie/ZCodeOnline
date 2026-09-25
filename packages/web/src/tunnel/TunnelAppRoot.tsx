// 隧道应用根（specs/web-tunnel.md）：主界面常驻渲染——未连接时用"挂起型 stub 服务"
// 驱动真实 UI（所有 RPC 永不返回 → 界面呈加载态），顶层盖不可关闭的连接引导模态；
// 连接成功换入真实服务（Root 按 key 重挂载），断开则模态重现、UI 回到加载态。
import { useCallback, useEffect, useRef, useState } from "react";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { connectViaProtocol } from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { TunnelConnectError, connectTunnelServices, type TunnelBootstrap } from "./tunnelSocket.js";
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

// ---- 门禁 UI 状态 ----

type GateStatus = "idle" | "pairing" | "connecting" | "disconnected";

interface GateState {
  visible: boolean;
  status: GateStatus;
  error: string | null;
  needsLogin: boolean;
}

/** 未连接时的静态应用骨架：与主界面同构的空态，视觉占位而非假交互。 */
function DisconnectedAppSkeleton() {
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
        // URL 规范化为机器的公开地址（specs/web-tunnel.md §5.9）：连接成功后把地址
        // 变成可分享/可收藏的 /<码> 形式；localhost 开发页直接跳转生产地址。
        void (async () => {
          try {
            const discovery = await discoverLocalPairing();
            if (!discovery) return;
            const assistResponse = await fetch("http://127.0.0.1:4950/tunnel/assist");
            if (!assistResponse.ok) return;
            const { code } = (await assistResponse.json()) as { code: string };
            if (window.location.origin === "https://zcode.skillpie.cn") {
              window.history.replaceState(null, "", `/${code}`);
            } else {
              window.location.replace(`https://zcode.skillpie.cn/${code}`);
            }
          } catch {
            // 发现不可达：保留当前 URL。
          }
        })();
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

  const handleReconnect = useCallback(() => {
    const session = loadTunnelSession();
    if (session) void connectWithSession(session);
  }, [connectWithSession]);

  // 挂载：已存会话直连；否则本地发现（宿主在本机时零输入自动配对）。
  useEffect(() => {
    const savedSession = loadTunnelSession();
    if (savedSession) {
      void connectWithSession(savedSession);
      return;
    }
    void (async () => {
      const discovery = await discoverLocalPairing();
      if (!discovery) return;
      patchGate({ status: "pairing" });
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
    })();
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
