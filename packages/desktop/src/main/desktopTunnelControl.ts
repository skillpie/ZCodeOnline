// 桌面隧道管理面（specs/web-tunnel.md §5.5 路线 B）：
// Renderer → Main → server-cli daemon 控制 socket。桌面只做管理转发，
// 连接器生命周期与配置文件归 daemon 的 Core 所有（见 server-cli tunnelRuntime）。
// 远程协助（§5.9）：读取/轮换本机远程码走同一控制链；远程码兑换票据是控制端
// 行为，因 relay 控制面 CORS 白名单不含桌面 origin，由 main 进程代理 fetch。
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import {
  DEFAULT_TUNNEL_RELAY_URL,
  PlatformChannels,
  relayHttpOrigin,
  revealAssistPsk,
  TunnelManagerPairing,
  TunnelManagerStatus,
  type RedeemAssistCodeResult,
  type TunnelAssistCode,
} from "@zcode/shared";
import {
  requestControl,
  resolveServerLayout,
  ControlRequestError,
} from "@zcode/server-cli/control";

const CONTROL_TIMEOUT_MS = 10_000;

interface TunnelControlResult {
  status: {
    enabled: boolean;
    connected: boolean;
    relayUrl: string | null;
    hostId: string;
    displayName: string;
  };
  pairingUrl?: string;
  expiresAt?: number;
}

function unreachableStatus(): TunnelManagerStatus {
  return {
    daemonReachable: false,
    enabled: false,
    connected: false,
    relayUrl: null,
    hostId: "",
    displayName: "",
  };
}

function isControlEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EINVAL";
}

async function forwardTunnelControl(
  command:
    | "tunnel-status"
    | "tunnel-enable"
    | "tunnel-disable"
    | "tunnel-pair"
    | "tunnel-assist-code"
    | "tunnel-assist-refresh",
  relayUrl?: string,
): Promise<TunnelControlResult> {
  const result = (await requestControl(
    resolveServerLayout().controlEndpoint,
    // id 由 requestControl 内部生成；这里透传命令与可选 relayUrl。
    { id: randomUUID(), command, ...(relayUrl ? { relayUrl } : {}) } as Parameters<
      typeof requestControl
    >[1],
    CONTROL_TIMEOUT_MS,
  )) as TunnelControlResult;
  return result;
}

/** assist 命令应答 → 平台契约的 TunnelAssistCode（daemon 复用 pairingUrl 字段携带码）。 */
function toAssistCode(result: TunnelControlResult): TunnelAssistCode {
  if (typeof result.pairingUrl !== "string" || result.pairingUrl === "") {
    throw new Error("Daemon returned no assist code");
  }
  return {
    code: result.pairingUrl,
    expiresAt: typeof result.expiresAt === "number" ? result.expiresAt : 0,
  };
}

export function registerTunnelControlIpcHandlers(): void {
  ipcMain.handle(PlatformChannels.TunnelStatus, async (): Promise<TunnelManagerStatus> => {
    try {
      const result = await forwardTunnelControl("tunnel-status");
      return { daemonReachable: true, ...result.status };
    } catch (error) {
      if (error instanceof ControlRequestError || isControlEndpointUnavailable(error)) {
        return unreachableStatus();
      }
      throw error;
    }
  });

  ipcMain.handle(
    PlatformChannels.TunnelEnable,
    async (_event, relayUrl: string): Promise<TunnelManagerStatus> => {
      const result = await forwardTunnelControl("tunnel-enable", relayUrl);
      return { daemonReachable: true, ...result.status };
    },
  );

  ipcMain.handle(PlatformChannels.TunnelDisable, async (): Promise<TunnelManagerStatus> => {
    const result = await forwardTunnelControl("tunnel-disable");
    return { daemonReachable: true, ...result.status };
  });

  ipcMain.handle(PlatformChannels.TunnelPair, async (): Promise<TunnelManagerPairing> => {
    const result = await forwardTunnelControl("tunnel-pair");
    if (typeof result.pairingUrl !== "string" || typeof result.expiresAt !== "number") {
      throw new Error("Daemon returned no pairing URL");
    }
    return { pairingUrl: result.pairingUrl, expiresAt: result.expiresAt };
  });

  ipcMain.handle(
    PlatformChannels.GetRemoteAssistCode,
    async (): Promise<TunnelAssistCode> =>
      toAssistCode(await forwardTunnelControl("tunnel-assist-code")),
  );

  ipcMain.handle(
    PlatformChannels.RefreshRemoteAssistCode,
    async (): Promise<TunnelAssistCode> =>
      toAssistCode(await forwardTunnelControl("tunnel-assist-refresh")),
  );

  ipcMain.handle(
    PlatformChannels.RedeemAssistCode,
    async (_event, code: string): Promise<RedeemAssistCodeResult> => redeemAssistCodeViaRelay(code),
  );
}

const REDEEM_TIMEOUT_MS = 10_000;

/**
 * 远程码兑换（码即凭证）：main 进程代理 POST /relay/api/v1/assist/connect。
 * relay 与 Web 客户端一致取产品默认入口（assist 邀请按 hostId 注册在宿主所连的
 * relay 上；自建 relay 场景两端都以 ZCODE_RELAY_URL/默认值对齐）。成功时在 main
 * 还原端到端 PSK（maskedPsk ⊕ SHA-256(code)），renderer 拿到即可发起隧道握手。
 */
async function redeemAssistCodeViaRelay(code: string): Promise<RedeemAssistCodeResult> {
  const zh = /^zh\b/i.test(globalThis.navigator?.language ?? "en");
  const t = (zhText: string, enText: string) => (zh ? zhText : enText);
  let response: Response;
  try {
    response = await fetch(`${relayHttpOrigin(DEFAULT_TUNNEL_RELAY_URL)}/api/v1/assist/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      kind: "network",
      message: t(
        "无法连接 relay 服务，请检查网络后重试。",
        "Cannot reach the relay; check your network.",
      ),
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      kind: "invalid",
      message: t("远程码无效或已被刷新。", "The assist code is invalid or has been rotated."),
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      kind: "rateLimited",
      message: t("尝试过于频繁，请稍后再试。", "Too many attempts. Try again shortly."),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      kind: "generic",
      message: t("兑换远程码失败，请稍后重试。", "Failed to redeem the assist code."),
    };
  }
  const body = (await response.json().catch(() => null)) as {
    hostId?: string;
    connectToken?: string;
    maskedPsk?: string;
  } | null;
  if (
    typeof body?.hostId !== "string" ||
    typeof body.connectToken !== "string" ||
    typeof body.maskedPsk !== "string"
  ) {
    return {
      ok: false,
      kind: "generic",
      message: t("兑换远程码失败，请稍后重试。", "Failed to redeem the assist code."),
    };
  }
  return {
    ok: true,
    hostId: body.hostId,
    connectToken: body.connectToken,
    psk: await revealAssistPsk(body.maskedPsk, code),
  };
}
