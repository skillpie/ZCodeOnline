import type { ZCodeAutomationRunOutcome, ZCodeAutomationTrigger } from "@zcode/shared";

// daemon 侧 automation run 台账生命周期，语义与桌面 packages/desktop/src/host/cronRunLifecycle.ts
// 对齐（跨模块深导入被架构策略禁止，故本地维护同语义实现；两侧改动需同步评审）。
// 口径：派发成功只代表 prompt 被 admission 接受；真实终态由 task 订阅收口。

export interface AutomationRunLifecycleRepo {
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void>;
  markRunOutcome(runId: string, outcome: ZCodeAutomationRunOutcome, error?: string): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "failed_to_dispatch";
    error: string;
  }): Promise<void>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

interface AutomationRunLifecycleIdentity {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

type LogWarn = (message: string, error: unknown) => void;

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export function startManualClaimHeartbeat(params: {
  automationId: string;
  runId: string;
  workspaceKey: string;
  repo: Pick<AutomationRunLifecycleRepo, "touchManualClaim">;
  logWarn: LogWarn;
  intervalMs?: number;
}): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo
      .touchManualClaim(params.automationId, params.workspaceKey)
      .catch((error) =>
        params.logWarn(
          `续租 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
          error,
        ),
      );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

export async function recordCronRunOutcomeBestEffort(
  params: AutomationRunLifecycleIdentity & {
    repo: AutomationRunLifecycleRepo;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.ensureRunClaimed(params);
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `回写定时任务运行结果失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

async function releaseManualClaimBestEffort(params: {
  automationId: string;
  runId: string;
  workspaceKey: string;
  repo: Pick<AutomationRunLifecycleRepo, "releaseManualClaim">;
  logWarn: LogWarn;
}): Promise<void> {
  try {
    await params.repo.releaseManualClaim(params.automationId, params.workspaceKey);
  } catch (error) {
    params.logWarn(
      `释放 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

/** manual claim 覆盖 queue 等待和 turn 执行，只能在真实终态后释放。 */
export async function settleCronRunTerminalOutcome(
  params: AutomationRunLifecycleIdentity & {
    repo: AutomationRunLifecycleRepo;
    outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}
