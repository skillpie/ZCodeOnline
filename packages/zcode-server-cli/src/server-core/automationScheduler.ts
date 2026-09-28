import { IModelSelectionService, IZCodeTaskService, type ServiceCollection } from "@zcode/services";
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationTrigger,
} from "@zcode/shared";
import {
  dispatchAutomationRun,
  type AutomationDispatchRepo,
  type AutomationDispatchTaskService,
} from "./automationDispatch.js";

// Core 进程内的 cron automation 调度循环（grill 决策：不单独 fork 子进程，崩溃走
// Supervisor 既有重启模型）。与桌面 scheduler 进程（packages/desktop/src/scheduler）
// 共享同一 tasks-index 库时，靠 AutomationRepo.claimDue 的 BEGIN IMMEDIATE 原子认领
// 互斥，桌面 app 与 daemon 并存不会重复执行；持有者崩溃后的认领由 CLAIM_STALE 僵尸
// 回收兜底（at-least-once，与桌面一致）。
// 事件顺序：20s 轮询 claimDue → misfire 判定 → upsertRunClaimed → 派发（不阻塞轮询）
// → 结算 markRunDispatch + markDispatched / markDispatchFailed 退避；manual run 由
// claimManualRuns 认领，同一 automation 的 single-flight 由 running 标志保证。
// 唯一状态所有者：tasks-index sqlite；本模块仅持有 runId → 结算上下文 的在途表，
// 重启丢失后靠僵尸认领回收，不引入第二份持久化状态。
// misfire 语义与桌面逐字对齐：错过窗口记 skipped 不补跑，一次性任务错过即终态。

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低（与桌面一致）。 */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「宿主未运行期间错过的窗口」→
 * 记 skipped 不补跑。取值需明显大于一次正常轮询延迟，又能覆盖短暂卡顿（与桌面一致）。
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

/** 派发失败的统一归类：daemon 侧派发错误都是传输/装配层可重试错误（桌面同款 transient）。 */
const DISPATCH_FAILURE_KIND = "transient" as const;

type AutomationSchedulerLogLevel = "info" | "warn" | "error";

type AutomationSchedulerLogger = (level: AutomationSchedulerLogLevel, message: string) => void;

export interface AutomationDispatchTargets {
  zcodeTaskService: AutomationDispatchTaskService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}

interface AutomationSchedulerParams {
  /** 生产入口：从 Core 的 services 集合解析派发目标。 */
  services?: ServiceCollection;
  /** 测试入口：直接注入派发目标桩，绕过 services 集合。 */
  resolveTargets?: () => AutomationDispatchTargets;
  /** 测试注入临时库路径；生产缺省走 ~/.zcode 的 tasks-index（与桌面/服务层同库）。 */
  repo?: AutomationRepo;
  log?: AutomationSchedulerLogger;
  pollIntervalMs?: number;
  /** 测试注入时钟；只影响认领窗口与 misfire 判定，落库时间戳仍由 repo 用真实时钟。 */
  now?: () => number;
}

export interface AutomationSchedulerHandle {
  /** 手动驱动一轮轮询（测试确定性；生产由 interval 调用）。 */
  tick(): Promise<void>;
  /** services 落库 manual run 后的即时派发入口（onAutomationManualRunRequested 注入）。 */
  dispatchManualRun(params: { automation: ZCodeAutomation; run: ZCodeAutomationRun }): Promise<void>;
  /** 释放本进程在途认领并停止轮询；Core shutdown 时调用，避免下轮启动等 CLAIM_STALE。 */
  dispose(): Promise<void>;
}

type InFlightContext = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

const defaultLogger: AutomationSchedulerLogger = (level, message) => {
  process.stderr.write(`${JSON.stringify({ level, message })}\n`);
};

/** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

export function startAutomationScheduler(params: AutomationSchedulerParams): AutomationSchedulerHandle {
  const log = params.log ?? defaultLogger;
  const now = params.now ?? Date.now;
  const repo: AutomationRepo & AutomationDispatchRepo =
    params.repo ?? (new AutomationRepo() as AutomationRepo & AutomationDispatchRepo);
  const pollIntervalMs = params.pollIntervalMs ?? POLL_INTERVAL_MS;

  const resolveTargets = (): AutomationDispatchTargets => {
    if (params.resolveTargets) return params.resolveTargets();
    if (!params.services) {
      throw new Error("automation scheduler 需要 services 或 resolveTargets 注入");
    }
    const zcodeTaskService = params.services.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      throw new Error("ZCode task service is not initialized.");
    }
    const modelSelectionService = params.services.getOptional(IModelSelectionService);
    if (!modelSelectionService) {
      throw new Error("Model Selection service is not initialized.");
    }
    return { zcodeTaskService, modelSelectionService };
  };

  let ready = false;
  let disposed = false;
  let ticking = false;
  let tickRequested = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const inFlight = new Map<string, InFlightContext>();

  function workspaceKeyOf(automation: ZCodeAutomation): string {
    return resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
  }

  /** 结算派发成功：run → dispatched，automation 推进 next_run_at / 计数（repo 权威）。 */
  async function settleSuccess(
    automationId: string,
    runId: string,
    trigger: ZCodeAutomationTrigger,
    taskId: string,
  ): Promise<void> {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId,
        sessionId: taskId,
        dispatchedAt: now(),
      });
      // manual claim 覆盖 queue + turn，成功时不释放；终态订阅收口时释放。
      return;
    }
    await repo.markRunDispatch({
      runId,
      dispatchStatus: "dispatched",
      sessionId: taskId,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now()) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now(), nextRunAt });
  }

  async function releaseManualClaimForFailedDispatch(
    automationId: string,
    runId: string,
    workspaceKey?: string,
  ): Promise<void> {
    // scheduler 重启 / 在途表丢失后仍可能结算迟到的 manual run；single-flight 锁必须
    // 用 run 台账或 automation 兜回 workspaceKey，否则会卡到 stale 回收（桌面同款兜底）。
    const releaseWorkspaceKey =
      workspaceKey ??
      (await repo.getRun(runId).then((run) => run?.workspaceKey ?? undefined)) ??
      (await repo.get(automationId).then((automation) => automation?.workspaceKey));
    if (!releaseWorkspaceKey) {
      log(
        "error",
        `manual claim release skipped: workspaceKey missing automation=${automationId} runId=${runId}`,
      );
      return;
    }
    await repo.releaseManualClaim(automationId, releaseWorkspaceKey);
  }

  /** 结算派发失败：run → failed_to_dispatch；schedule 走退避重试，manual 释放 single-flight。 */
  async function settleFailure(
    automationId: string,
    runId: string,
    trigger: ZCodeAutomationTrigger,
    workspaceKey: string | undefined,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await repo.markRunDispatch({
      runId,
      dispatchStatus: "failed_to_dispatch",
      error: message,
    });
    if (trigger === "manual") {
      await releaseManualClaimForFailedDispatch(automationId, runId, workspaceKey);
      return;
    }
    const automation = await repo.get(automationId);
    await repo.markDispatchFailed(automationId, {
      failedAt: now(),
      error: message,
      kind: DISPATCH_FAILURE_KIND,
      // transient 达上限后循环任务跳下一个正常 next_run_at。
      nextRunAt: automation ? computeAutomationNextRunAt(automation, now()) : null,
    });
  }

  async function runDispatch(
    automation: ZCodeAutomation,
    runId: string,
    trigger: ZCodeAutomationTrigger,
    fixedSelection?: ZCodeAutomationRun["modelSelection"],
  ): Promise<void> {
    const workspaceKey = workspaceKeyOf(automation);
    inFlight.set(runId, { automationId: automation.automationId, workspaceKey, trigger });
    try {
      const targets = resolveTargets();
      const result = await dispatchAutomationRun({
        request: {
          automationId: automation.automationId,
          runId,
          prompt: automation.prompt,
          ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
          ...((fixedSelection ?? automation.modelSelection)
            ? { modelSelection: fixedSelection ?? automation.modelSelection }
            : {}),
          ...(automation.mode ? { mode: automation.mode } : {}),
          workspacePath: automation.workspacePath,
          ...(automation.workspaceIdentity
            ? { workspaceIdentity: automation.workspaceIdentity }
            : {}),
          scheduledAt: resolveScheduledAt(automation, now()),
          trigger,
        },
        repo,
        zcodeTaskService: targets.zcodeTaskService,
        modelSelectionService: targets.modelSelectionService,
        logWarn: (message, error) => log("warn", `${message}: ${String(error)}`),
      });
      await settleSuccess(automation.automationId, runId, trigger, result.taskId);
    } catch (error) {
      await settleFailure(automation.automationId, runId, trigger, workspaceKey, error);
    } finally {
      inFlight.delete(runId);
    }
  }

  async function handleClaimed(automation: ZCodeAutomation, tickNow: number): Promise<void> {
    const scheduledAt = resolveScheduledAt(automation, tickNow);
    const runId = buildRunId(automation.automationId, scheduledAt);
    const workspaceKey = workspaceKeyOf(automation);
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
    const missed =
      !isRetry &&
      automation.nextRunAt != null &&
      automation.nextRunAt <= tickNow - MISFIRE_GRACE_MS;
    if (missed) {
      // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
      // 通用重算会给出 anchorAt + k*interval 的下一周期，让「只跑一次」的提醒在后续
      // 周期继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
      const finalize = isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, tickNow);
      await repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "computer_asleep_or_app_not_running",
        nextRunAt,
        finalize,
      });
      log(
        "info",
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
      );
      return;
    }

    // 正常派发：先落/更新 run 台账（claimed），再异步派发；不阻塞本轮后续认领。
    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
      // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
    });
    void runDispatch(automation, runId, "schedule")
      .then(() => requestTick())
      .catch(() => {
        // settleFailure 内部已兜底记录；这里只保证 promise 链不产生 unhandled rejection。
      });
  }

  async function tick(): Promise<void> {
    if (disposed || !ready || ticking) return;
    ticking = true;
    try {
      do {
        tickRequested = false;
        try {
          const tickNow = now();
          const claimed = await repo.claimDue(tickNow);
          for (const automation of claimed) {
            await handleClaimed(automation, tickNow);
          }
          const manualRuns = await repo.claimManualRuns(tickNow);
          for (const manualRun of manualRuns) {
            // manual run 由 runNow 认领（UI「立即运行」）或上个进程遗留；同一 automation
            // 已有派发在途时 running=1 不会被认领到，single-flight 由 DB 保证。
            await runDispatch(
              manualRun.automation,
              manualRun.run.runId,
              "manual",
              manualRun.run.modelSelection ?? undefined,
            );
          }
        } catch (error) {
          log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // 派发结算可能与本 tick 重叠；直接丢弃会让用户等待下一轮 20 秒轮询，
        // 记 pending 并在本轮完成后立即补跑（桌面同款）。
      } while (tickRequested && !disposed);
    } finally {
      ticking = false;
    }
  }

  /** 引导完成后才允许 tick / 派发；引导失败（库打不开）保持 !ready，所有入口空转。 */
  const bootstrap = (async () => {
    try {
      await repo.ensureReady();
    } catch (error) {
      log(
        "error",
        `automation scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (disposed) return;
    ready = true;
    log("info", "automation scheduler started");
    pollTimer = setInterval(() => void tick(), pollIntervalMs);
    void tick();
  })();

  function requestTick(): void {
    if (disposed) return;
    if (!ready || ticking) {
      tickRequested = true;
      return;
    }
    void tick();
  }

  const handle: AutomationSchedulerHandle = {
    async tick() {
      await bootstrap;
      await tick();
    },
    async dispatchManualRun(manualParams) {
      await bootstrap;
      // services 落库 manual run 后的即时派发路径；调度循环的 claimManualRuns 是
      // 重启恢复兜底，两条路径靠 running single-flight 互斥，不会重复派发。
      await runDispatch(
        manualParams.automation,
        manualParams.run.runId,
        "manual",
        manualParams.run.modelSelection ?? undefined,
      );
      requestTick();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
      for (const [runId, context] of inFlight) {
        try {
          if (context.trigger === "manual") {
            await releaseManualClaimForFailedDispatch(context.automationId, runId, context.workspaceKey);
          } else {
            await repo.releaseClaim(context.automationId);
          }
        } catch {
          // 忽略：退出路径尽力而为。
        }
      }
      inFlight.clear();
      try {
        repo.close();
      } catch {
        // 忽略。
      }
    },
  };

  return handle;
}
