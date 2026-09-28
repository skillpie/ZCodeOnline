import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/services/node";
import { IZCodeAgentService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { coreCommandSchema } from "../contracts.js";
import { startAutomationScheduler, type AutomationSchedulerHandle } from "./automationScheduler.js";
import { createCoreHttpServer } from "./http.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { startTunnelDiscoveryServer } from "../tunnel/tunnelDiscovery.js";
import { createTunnelRuntime } from "../tunnel/tunnelRuntime.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(generation: number): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  // manual run 即时派发钩子：调度器实例在 services 装配后才创建，先到的 manual run
  // 留在队列里由首轮 tick 的 claimManualRuns 兜底派发，不会丢失。
  let automationSchedulerRef: AutomationSchedulerHandle | undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: "standalone-server",
    onAutomationManualRunRequested: (params) =>
      automationSchedulerRef?.dispatchManualRun(params) ?? Promise.resolve(),
  });
  // 调度循环挂在 Core 进程内（grill 决策）：与桌面 scheduler 进程共享同一 tasks-index 库，
  // 靠 AutomationRepo.claimDue 的 BEGIN IMMEDIATE 原子认领互斥，桌面 app 与 daemon
  // 并存不会重复执行。misfire/退避/终态语义与桌面 scheduler 逐字对齐。
  const automationScheduler = startAutomationScheduler({
    services,
    log: (level, message) => {
      process.stderr.write(
        `${JSON.stringify({ level, message: `[automation-scheduler] ${message}` })}\n`,
      );
    },
  });
  automationSchedulerRef = automationScheduler;
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  const http = await createCoreHttpServer(services, { serverId: await resolveCoreServerId() });
  // 隧道运行时归 Core 所有（specs/web-tunnel.md §3.2）：与 loopback server 同进程，
  // 拼接流直连本机 /ws；serverRoot 与 Supervisor 同 env，按同一公式解析。
  const tunnel = createTunnelRuntime({
    serverRoot: resolveServerLayout().serverRoot,
    loopbackPort: http.port,
  });
  // 本地配对发现端点（specs/web-tunnel.md §5.8）：浏览器打开网站即自动探测配对。
  // 端口被占/失败非致命（手动配对仍可用）；core 无专用 logger，stderr 结构化输出随
  // supervisor journal 采集。
  const tunnelDiscovery = await startTunnelDiscoveryServer({
    pair: async () => {
      const result = await tunnel.handle("pair");
      return {
        pairingUrl: result.pairingUrl ?? "",
        expiresAt: result.expiresAt ?? 0,
        status: { hostId: result.status.hostId, displayName: result.status.displayName },
      };
    },
    assist: {
      ensure: async () => {
        const result = await tunnel.handle("assist-code");
        return { code: result.pairingUrl ?? "", expiresAt: result.expiresAt ?? 0 };
      },
      refresh: async () => {
        const result = await tunnel.handle("assist-refresh");
        return { code: result.pairingUrl ?? "", expiresAt: result.expiresAt ?? 0 };
      },
    },
  }).catch(() => null);
  if (tunnelDiscovery) {
    process.stderr.write(
      `${JSON.stringify({ level: "info", message: "tunnel discovery listening", port: tunnelDiscovery.port })}\n`,
    );
  }
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: ZCODE_VERSION,
    generation,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({ type: "task-activity", runningTaskCount });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({ type: "task-activity", runningTaskCount });
        }
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount });
      })
      .catch(() => {
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount: lastRunningTaskCount });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    // 先释放 automation 在途认领并停轮询，再释放 services（repo close 依赖库仍可用）。
    await automationScheduler.dispose().catch(() => undefined);
    tunnel.dispose();
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  process.on("message", (message: unknown) => {
    const parsed = coreCommandSchema.safeParse(message);
    if (!parsed.success) return;
    if (parsed.data.command === "shutdown") {
      void shutdown("requested");
      return;
    }
    // tunnel-control：转发自 Supervisor 的控制命令，结果按 requestId 关联回去。
    const { requestId, action, relayUrl } = parsed.data;
    tunnel
      .handle(action, relayUrl)
      .then((result) => {
        void send({ type: "tunnel-control-result", requestId, ok: true, result });
      })
      .catch((error: unknown) => {
        void send({
          type: "tunnel-control-result",
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
