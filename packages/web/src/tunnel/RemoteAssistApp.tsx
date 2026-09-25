// 远程控制会话（specs/web-tunnel.md §5.9）：B 打开 /<码>，兑换持久机器码后
// 连入 A 的宿主——应用渲染/端到端加密与自机隧道全复用，授权模型是"码即凭证"。
import { useCallback, useEffect, useRef, useState } from "react";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import { DEFAULT_TUNNEL_RELAY_URL, normalizeAssistCode, revealAssistPsk } from "@zcode/shared";
import { TunnelConnectError, connectTunnelServices, type TunnelBootstrap } from "./tunnelSocket.js";
import { DisconnectedAppSkeleton } from "./TunnelAppRoot.js";
import type { TunnelServices } from "./TunnelAppRoot.js";

type Phase = "connecting" | "connected" | "error";

const zh = (): boolean => /^zh\b/i.test(navigator.language);
const t = (zhText: string, enText: string) => (/^zh\b/i.test(navigator.language) ? zhText : enText);

async function redeemAssistCode(code: string): Promise<{
  hostId: string;
  connectToken: string;
  psk: string;
}> {
  const response = await fetch("/relay/api/v1/assist/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (response.status === 401) {
    throw new Error(t("远程码无效或已被使用。", "The assist code is invalid or already used."));
  }
  if (response.status === 429) {
    throw new Error(t("尝试过于频繁，请稍后再试。", "Too many attempts. Try again shortly."));
  }
  if (!response.ok) {
    throw new Error(t("兑换远程码失败，请稍后重试。", "Failed to redeem the assist code."));
  }
  const body = (await response.json()) as {
    hostId: string;
    connectToken: string;
    maskedPsk: string;
  };
  return {
    hostId: body.hostId,
    connectToken: body.connectToken,
    psk: await revealAssistPsk(body.maskedPsk, code),
  };
}

export function RemoteAssistApp({ code, platform }: { code: string; platform: IPlatformService }) {
  const normalized = normalizeAssistCode(code);
  const [phase, setPhase] = useState<Phase>(normalized ? "connecting" : "error");
  const [error, setError] = useState<string | null>(
    normalized
      ? null
      : t("远程码无效：应为 16 位数字。", "Invalid assist code: expected 16 digits."),
  );
  const [services, setServices] = useState<TunnelServices | null>(null);
  const [bootstrap, setBootstrap] = useState<TunnelBootstrap | undefined>(undefined);
  const startedRef = useRef(false);

  const connect = useCallback(async (assistCode: string) => {
    setPhase("connecting");
    setError(null);
    try {
      const redeemed = await redeemAssistCode(assistCode);
      const connected = await connectTunnelServices({
        relayUrl: DEFAULT_TUNNEL_RELAY_URL,
        hostId: redeemed.hostId,
        psk: redeemed.psk,
        connectToken: redeemed.connectToken,
        onClose: () => {
          // 断开（A 下线/网络断）：码长期有效，重连即可。
          setServices(null);
          setPhase("error");
          setError(
            t(
              "连接已断开：远程电脑当前不在线。",
              "Disconnected: the remote machine is currently offline.",
            ),
          );
        },
      });
      document.title = "ZCode Online";
      setServices(connected.services);
      setBootstrap(connected.bootstrap);
      setPhase("connected");
    } catch (cause) {
      setPhase("error");
      setError(
        cause instanceof TunnelConnectError || cause instanceof Error
          ? cause.message
          : String(cause),
      );
    }
  }, []);

  // 自动重试（持久机器码）：错误态按指数退避周期重试（5s→30s 封顶），
  // 宿主（zcode serve）回来后自动恢复——无需用户点击。
  const [retryCount, setRetryCount] = useState(0);
  useEffect(() => {
    if (phase !== "error" || !normalized) return;
    const attempt = retryCount + 1;
    const delay = Math.min(5_000 * 2 ** (attempt - 1), 30_000);
    const timer = setTimeout(() => {
      setRetryCount(attempt);
      void connect(normalized);
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retryCount 变化驱动下一轮
  }, [phase, retryCount]);

  useEffect(() => {
    if (startedRef.current || !normalized) return;
    startedRef.current = true;
    void connect(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 一次性启动
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
              key="remote-assist"
              services={services}
              platform={platform}
              suppressJwtInvalidReload
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
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
        <>
          <DisconnectedAppSkeleton />
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
            <section className="w-full max-w-lg rounded-xl border border-card-border bg-card p-5 shadow-xl">
              <div className="flex items-center gap-3">
                <span
                  className={`size-2 rounded-full ${
                    phase === "connecting" ? "animate-pulse bg-amber-500" : "bg-destructive"
                  }`}
                />
                <h1 className="text-ui-xs font-medium">{t("远程控制", "Remote control")}</h1>
              </div>
              {phase === "connecting" ? (
                <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">
                  {t(
                    "正在通过加密隧道接入远程电脑，代码与文件只在被控机器上处理。",
                    "Connecting over an encrypted tunnel; code and files stay on the controlled machine.",
                  )}
                </p>
              ) : null}
              {error !== null ? (
                <p className="mt-3 break-all text-ui-xs/relaxed text-destructive">{error}</p>
              ) : null}
              {phase === "error" ? (
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    type="button"
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-center text-ui-xs text-foreground hover:bg-surface-hover"
                    onClick={() => {
                      if (normalized) void connect(normalized);
                    }}
                  >
                    {t("重新连接", "Reconnect")}
                  </button>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-center text-ui-xs text-foreground hover:bg-surface-hover"
                    onClick={() => {
                      const next =
                        window.prompt(t("输入 16 位远程码：", "Enter the 16-digit remote code:")) ??
                        "";
                      const valid = normalizeAssistCode(next);
                      if (valid) void connect(valid);
                    }}
                  >
                    {t("换一个远程码", "Use another code")}
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
