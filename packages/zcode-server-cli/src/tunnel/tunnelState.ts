// 隧道宿主身份数据（specs/web-tunnel.md §3.2）：hostId / 宿主凭证 / PSK 持久化。
// 凭证与 PSK 是宿主侧唯一的秘密，必须落在本机数据目录（0600），relay 与浏览器侧永不持久化宿主凭证。
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateTunnelSecret } from "@zcode/shared";

export interface TunnelAssistState {
  code: string;
  psk: string;
}

export interface TunnelHostState {
  hostId: string;
  hostCredential: string;
  displayName: string;
  psk: string;
  /** 持久机器码（specs/web-tunnel.md §5.9）：跨重启稳定，是本机的可分享地址。 */
  assist?: TunnelAssistState;
}

export interface TunnelStateStore {
  load(): Promise<TunnelHostState | null>;
  save(state: TunnelHostState): Promise<void>;
  clear(): Promise<void>;
}

export function resolveTunnelStateFile(serverRoot: string): string {
  return join(serverRoot, "tunnel", "state.json");
}

export function createTunnelStateStore(serverRoot: string): TunnelStateStore {
  const stateFile = resolveTunnelStateFile(serverRoot);
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(stateFile, "utf8");
      } catch {
        return null;
      }
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (
          typeof data.hostId !== "string" ||
          typeof data.hostCredential !== "string" ||
          typeof data.displayName !== "string" ||
          typeof data.psk !== "string"
        ) {
          return null;
        }
        const assist =
          typeof data.assist === "object" &&
          data.assist !== null &&
          typeof (data.assist as Record<string, unknown>).code === "string" &&
          typeof (data.assist as Record<string, unknown>).psk === "string"
            ? {
                code: (data.assist as { code: string }).code,
                psk: (data.assist as { psk: string }).psk,
              }
            : undefined;
        return {
          hostId: data.hostId,
          hostCredential: data.hostCredential,
          displayName: data.displayName,
          psk: data.psk,
          ...(assist ? { assist } : {}),
        };
      } catch {
        return null;
      }
    },
    async save(state) {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
      await chmod(stateFile, 0o600);
    },
    async clear() {
      await rm(join(serverRoot, "tunnel"), { recursive: true, force: true });
    },
  };
}

/** 首次启用隧道时生成宿主身份；hostId 用短随机串便于二维码展示。 */
export function createTunnelHostState(displayName: string): TunnelHostState {
  return {
    hostId: `zc-${generateTunnelSecret(9)}`,
    hostCredential: "",
    displayName,
    psk: generateTunnelSecret(),
  };
}
