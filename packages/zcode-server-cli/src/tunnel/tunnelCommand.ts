// 前台隧道命令（specs/web-tunnel.md §3.2；联调与轻量托管入口）：
// `zcode tunnel [--pair] [--relay-url <url>] [--port 3030] [--display-name x]`
// relay 缺省用产品部署入口（DEFAULT_TUNNEL_RELAY_URL / ZCODE_RELAY_URL 可覆盖）。
// 拼接流桥接到本机 loopback 业务服务的 /ws；与 serve 守护进程互斥使用（同一 hostId
// 双连接会被 relay 顶替互踢）。宿主身份持久化在 <server-root>/tunnel/state.json（0600）。
import { hostname } from "node:os";
import { DEFAULT_TUNNEL_RELAY_URL } from "@zcode/shared";
import type { CliIO } from "../cli.js";
import type { ServerLayout } from "../runtime/paths.js";
import { TunnelConnector, type TunnelConnectorEvent } from "./tunnelConnector.js";
import { startTunnelDiscoveryServer } from "./tunnelDiscovery.js";
import { startPairingSession } from "./tunnelPairing.js";
import { createTunnelHostState, createTunnelStateStore } from "./tunnelState.js";

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function describeEvent(event: TunnelConnectorEvent): string {
  switch (event.kind) {
    case "connected":
      return "tunnel connected";
    case "disconnected":
      return "tunnel disconnected";
    case "reconnecting":
      return `reconnecting in ${event.delayMs}ms`;
    case "streamOpened":
      return `stream opened: ${event.streamId}`;
    case "streamClosed":
      return `stream closed: ${event.streamId}`;
    case "error":
      return `error: ${event.message}`;
    default:
      return event.kind;
  }
}

export async function runTunnelCommand(
  argv: readonly string[],
  io: CliIO,
  layout: ServerLayout,
): Promise<number> {
  const relayUrl =
    flagValue(argv, "--relay-url") ??
    process.env.ZCODE_RELAY_URL?.trim() ??
    DEFAULT_TUNNEL_RELAY_URL;
  const businessPort = Number(flagValue(argv, "--port") ?? 3030);
  if (!Number.isInteger(businessPort) || businessPort <= 0) {
    stderr(io, new Error("--port must be a positive integer"));
    return 2;
  }
  const displayName = flagValue(argv, "--display-name") ?? hostname();

  const state = createTunnelStateStore(layout.serverRoot);
  let hostState = await state.load();
  if (!hostState) {
    hostState = createTunnelHostState(displayName);
    await state.save(hostState);
    stdout(io, { event: "host-identity-created", hostId: hostState.hostId });
  }

  const connector = new TunnelConnector({
    relayUrl,
    hostId: hostState.hostId,
    hostCredential: hostState.hostCredential,
    displayName: hostState.displayName,
    psk: hostState.psk,
    loopbackWsUrl: `ws://127.0.0.1:${businessPort}/ws`,
    onCredentialIssued: (credential) => {
      void state.save({ ...hostState, hostCredential: credential }).catch(() => undefined);
    },
    onCredentialInvalid: () => {
      // relay 重启导致凭证失效：清持久化凭证，连接器将以空凭证重注册并拿到新凭证。
      void state.save({ ...hostState, hostCredential: "" }).catch(() => undefined);
    },
    initialAssist: hostState.assist,
    onAssistChange: (assist) => {
      void state
        .save({ ...hostState, assist: { code: assist.code, psk: assist.psk } })
        .catch(() => undefined);
    },
    onEvent: (event) => {
      stderr(io, describeEvent(event));
    },
  });

  if (argv.includes("--pair")) {
    const session = await startPairingSession({ connector, hostId: hostState.hostId, displayName });
    stdout(io, {
      event: "pairing-ready",
      expiresAt: session.expiresAt,
      pairingUrl: session.url,
      hint: "浏览器粘贴此链接完成配对；若模型尚未登录，请先运行 zcode login",
    });
    // 配对码到点作废后自动清掉待登记，避免过期 token 残留在重连补发路径上。
    setTimeout(
      () => session.dispose(),
      Math.max(session.expiresAt - Date.now(), 0) + 1_000,
    ).unref();
  }

  const stopped = new Promise<void>((resolve) => {
    const stop = (): void => {
      connector.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  connector.start();

  // 本地配对发现端点（specs/web-tunnel.md §5.8）：浏览器打开网站即自动配对，
  // 无需手动粘贴；--pair 仍打印 URL 供手机/扫码使用。
  const discovery = await startTunnelDiscoveryServer({
    pair: async () => {
      const session = await startPairingSession({
        connector,
        hostId: hostState.hostId,
        displayName,
      });
      return {
        pairingUrl: session.url,
        expiresAt: session.expiresAt,
        status: { hostId: hostState.hostId, displayName },
      };
    },
    assist: {
      ensure: () => connector.ensureAssistCode(),
      refresh: () => connector.regenerateAssistCode(),
    },
  }).catch(() => null);
  if (discovery) {
    stderr(io, `discovery: http://127.0.0.1:${discovery.port}/tunnel/pairing`);
  }

  await stopped;
  if (discovery) await discovery.close();
  return 0;
}

const stdout = (io: CliIO, value: unknown): void => io.stdout?.write(`${JSON.stringify(value)}\n`);
const stderr = (io: CliIO, value: unknown): void =>
  io.stderr?.write(`${value instanceof Error ? value.message : String(value)}\n`);
