// Core 进程内的隧道运行时（specs/web-tunnel.md §3.2 daemon 集成）。
// 唯一所有者：连接器生命周期与 tunnel/config.json 都归 Core；Supervisor 只做控制转发，
// CLI 不直接写配置（避免双写路径）。身份（state.json）与配置（config.json）分离：
// config 是用户意图（开关 + relay 地址），state 是宿主身份秘密。
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DEFAULT_TUNNEL_RELAY_URL } from "@zcode/shared";
import { dirname, join } from "node:path";
import { TunnelConnector, type TunnelConnectorEvent } from "./tunnelConnector.js";
import { startPairingSession, type PairingSessionHandle } from "./tunnelPairing.js";
import {
  createTunnelHostState,
  createTunnelStateStore,
  type TunnelHostState,
} from "./tunnelState.js";

export interface TunnelConfig {
  enabled: boolean;
  relayUrl: string;
}

export interface TunnelRuntimeStatus {
  enabled: boolean;
  relayUrl: string | null;
  connected: boolean;
  hostId: string;
  displayName: string;
}

export interface TunnelActionResult {
  status: TunnelRuntimeStatus;
  pairingUrl?: string;
  expiresAt?: number;
}

export interface TunnelRuntimeOptions {
  serverRoot: string;
  loopbackPort: number;
  onEvent?: (event: TunnelConnectorEvent) => void;
}

export interface TunnelRuntime {
  handle(
    action: "status" | "enable" | "disable" | "pair" | "assist-code" | "assist-refresh",
    relayUrl?: string,
  ): Promise<TunnelActionResult>;
  /** Core 关停时调用：停连接器、清配对会话。 */
  dispose(): void;
}

const CONFIG_FILE = "config.json";

export function resolveTunnelConfigFile(serverRoot: string): string {
  return join(serverRoot, "tunnel", CONFIG_FILE);
}

export function createTunnelRuntime(options: TunnelRuntimeOptions): TunnelRuntime {
  const configFile = resolveTunnelConfigFile(options.serverRoot);
  const identity = createTunnelStateStore(options.serverRoot);
  let connector: TunnelConnector | null = null;
  let pairing: PairingSessionHandle | null = null;
  let identityCache: TunnelHostState | null = null;
  let config: TunnelConfig = { enabled: false, relayUrl: "" };
  let disposed = false;
  // handle 动作串行化：并发 enable/disable 与启动恢复交错会泄漏连接器或回写已删配置。
  let queue: Promise<unknown> = Promise.resolve();

  async function ensureIdentity(): Promise<TunnelHostState> {
    if (!identityCache) {
      identityCache = (await identity.load()) ?? createTunnelHostState(hostname());
      await identity.save(identityCache);
    }
    return identityCache;
  }

  async function loadConfig(): Promise<void> {
    // 默认开启（specs/web-tunnel.md §5.7）：从未配置过的机器，serve 起来即连产品 relay，
    // 配对码是唯一门禁（未配对无人可连）。用户显式 disable 会持久化 enabled=false，
    // 此后每次启动都尊重该选择。
    config = {
      enabled: true,
      relayUrl: process.env.ZCODE_RELAY_URL?.trim() || DEFAULT_TUNNEL_RELAY_URL,
    };
    try {
      const raw = JSON.parse(await readFile(configFile, "utf8")) as Partial<TunnelConfig>;
      if (typeof raw.enabled === "boolean") {
        config = {
          enabled: raw.enabled,
          relayUrl:
            typeof raw.relayUrl === "string" && raw.relayUrl.length > 0
              ? raw.relayUrl
              : config.relayUrl,
        };
      }
    } catch {
      // 无配置文件 = 出厂默认；解析失败同样走默认（下次 save 覆盖）。
    }
  }

  async function saveConfig(): Promise<void> {
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  function stopConnector(): void {
    pairing?.dispose();
    pairing = null;
    connector?.stop();
    connector = null;
  }

  function currentStatus(): TunnelRuntimeStatus {
    return {
      enabled: config.enabled,
      relayUrl: config.enabled ? config.relayUrl : null,
      connected: connector !== null,
      hostId: identityCache?.hostId ?? "",
      displayName: identityCache?.displayName ?? "",
    };
  }

  async function handleInner(
    action: "status" | "enable" | "disable" | "pair" | "assist-code" | "assist-refresh",
    relayUrl?: string,
  ): Promise<TunnelActionResult> {
    if (disposed) throw new Error("Tunnel runtime is disposed");
    if (action === "status") {
      await ensureIdentity();
      return { status: currentStatus() };
    }
    if (action === "enable") {
      const effectiveRelayUrl =
        relayUrl?.trim() || process.env.ZCODE_RELAY_URL?.trim() || DEFAULT_TUNNEL_RELAY_URL;
      const state = await ensureIdentity();
      stopConnector();
      config = { enabled: true, relayUrl: effectiveRelayUrl };
      await saveConfig();
      connector = new TunnelConnector({
        relayUrl: effectiveRelayUrl,
        hostId: state.hostId,
        hostCredential: state.hostCredential,
        displayName: state.displayName,
        psk: state.psk,
        loopbackWsUrl: `ws://127.0.0.1:${options.loopbackPort}/ws`,
        // 持久机器码：初值取身份文件，生成/轮换后回存（specs/web-tunnel.md §5.9）。
        initialAssist: state.assist,
        onAssistChange: (assist) => {
          void identity
            .load()
            .then((state2) => {
              if (state2) {
                return identity.save({ ...state2, assist: { code: assist.code, psk: assist.psk } });
              }
              return undefined;
            })
            .catch(() => undefined);
        },
        onCredentialIssued: (credential) => {
          // relay 首连签发宿主凭证后持久化，重启沿用（不再触发二次签发）。
          void identity
            .load()
            .then((state2) => {
              if (state2) return identity.save({ ...state2, hostCredential: credential });
              return undefined;
            })
            .catch(() => undefined);
        },
        onCredentialInvalid: () => {
          // relay 重启清空注册表：清持久化凭证，连接器重注册自愈（specs/web-tunnel.md §3.5）。
          void identity
            .load()
            .then((state2) => {
              if (state2) return identity.save({ ...state2, hostCredential: "" });
              return undefined;
            })
            .catch(() => undefined);
        },
        onEvent: options.onEvent,
      });
      connector.start();
      return { status: currentStatus() };
    }
    if (action === "disable") {
      stopConnector();
      config = { enabled: false, relayUrl: "" };
      // 持久化关闭（不能删文件）：出厂默认是开启，删掉会让 disable 在重启后复活。
      await saveConfig();
      return { status: currentStatus() };
    }
    // assist-code / assist-refresh：远程协助邀请（连接器持有，随重连补登记）。
    if (action === "assist-code" || action === "assist-refresh") {
      if (!connector) {
        throw new Error("Tunnel is not enabled; enable it with --relay-url first");
      }
      const invitation =
        action === "assist-refresh"
          ? await connector.regenerateAssistCode()
          : await connector.ensureAssistCode();
      return {
        status: currentStatus(),
        pairingUrl: invitation.code,
        expiresAt: invitation.expiresAt,
      };
    }
    // pair：连接器必须已启用；一次只保留一个活跃配对会话，过期后自动清理。
    if (!connector) {
      throw new Error("Tunnel is not enabled; enable it with --relay-url first");
    }
    pairing?.dispose();
    const state = await ensureIdentity();
    const session = await startPairingSession({
      connector,
      hostId: state.hostId,
      displayName: state.displayName,
    });
    pairing = session;
    const expiresAt = session.expiresAt;
    setTimeout(
      () => {
        if (pairing === session) pairing = null;
        session.dispose();
      },
      Math.max(expiresAt - Date.now(), 0) + 1_000,
    ).unref();
    return { status: currentStatus(), pairingUrl: session.url, expiresAt };
  }

  // 队首 = 加载配置 + 出厂默认自动启用：所有用户命令都排在它之后，
  // status/pair 看到的状态确定不含竞态（loadConfig 是异步的，直排会读到初始值）。
  const initialized: Promise<void> = loadConfig().then(() => {
    if (disposed || !config.enabled || !config.relayUrl) return undefined;
    return handleInner("enable", config.relayUrl)
      .then(() => handleInner("assist-code"))
      .then(
        () => undefined,
        () => undefined,
      );
  });

  const handle: TunnelRuntime["handle"] = (action, relayUrl) => {
    const next = queue
      .then(
        () => initialized,
        () => initialized,
      )
      .then(
        () => handleInner(action, relayUrl),
        () => handleInner(action, relayUrl),
      );
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    handle,
    dispose() {
      disposed = true;
      stopConnector();
    },
  };
}
