// 桌面隧道管理面（specs/web-tunnel.md §5.5 路线 B）：
// Renderer → Main → server-cli daemon 控制 socket。桌面只做管理转发，
// 连接器生命周期与配置文件归 daemon 的 Core 所有（见 server-cli tunnelRuntime）。
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { TunnelManagerPairing, TunnelManagerStatus, PlatformChannels } from "@zcode/shared";
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
  command: "tunnel-status" | "tunnel-enable" | "tunnel-disable" | "tunnel-pair",
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
}
