import type { IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import type {
  ModelSelection,
  TraceId,
  ZCodeAutomationTrigger,
  ZCodeTaskMode,
} from "@zcode/shared";
import {
  formatModelPickerValue,
  resolveWorkspaceKey,
} from "@zcode/shared";
import {
  recordCronRunOutcomeBestEffort,
  settleCronRunTerminalOutcome,
  startManualClaimHeartbeat,
  type AutomationRunLifecycleRepo,
} from "./automationRunLifecycle.js";

// daemon 侧 automation run 派发，语义与桌面 packages/desktop/src/host/index.ts 的
// dispatchCronRun / automationModelSelection.ts / trackCronRunOutcome 对齐：
// createTask/resume → 固定模型身份 → sendPrompt → 订阅终态回写台账。
// 桌面特有部分（parentPort 遥测、Bot 回推）daemon 首期不接；跨模块深导入被
// 架构策略禁止，故本地维护同语义实现，两侧改动需同步评审。

/** 仅取派发用到的成员，测试可用最小桩实现。 */
export interface AutomationDispatchTaskService {
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mode?: ZCodeTaskMode;
    model?: string;
    thoughtLevel?: string;
    automationId?: string;
  }): Promise<{ taskId: string }>;
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    model?: string;
    thoughtLevel?: string;
    automationId?: string;
  }): Promise<unknown>;
  setAutomationSessionConfig(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: ZCodeTaskMode;
  }): Promise<unknown>;
  setConfigOption(params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }): Promise<unknown>;
  // sendPrompt 的真实参数带 ZCodeBackgroundTurnAttribution 互斥判别约束，
  // 直接收窄会破坏逆变；此处沿用真实签名，调用点只传 automationId 归因字段。
  sendPrompt(
    ...args: Parameters<IZCodeTaskService["sendPrompt"]>
  ): ReturnType<IZCodeTaskService["sendPrompt"]>;
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
  }): Promise<unknown>;
  onDynamicTaskTerminalOutcome(taskId: string): {
    (listener: (result: {
      taskId: string;
      inputId?: string;
      outcome: "succeeded" | "failed" | "stopped";
      error?: string;
    }) => void): { dispose(): void };
  };
}

export interface AutomationDispatchRepo extends AutomationRunLifecycleRepo {
  getRun(runId: string): Promise<{ modelSelection?: ModelSelection | null } | null>;
  getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined>;
  fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection>;
}

/** 在 Automation Select 转为一次 Submission 的边界固定模型身份（桌面 automationModelSelection.ts 同语义）。 */
async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  // 派发方快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }
  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}

interface AutomationDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

/** 派发在途的终态订阅登记：Core 进程内单例持有，进程退出随生命周期释放。 */
const runOutcomeSubscriptions = new Map<string, { dispose(): void }>();

function disposeRunOutcomeSubscription(key: string): void {
  runOutcomeSubscriptions.get(key)?.dispose();
  runOutcomeSubscriptions.delete(key);
}

async function applyAutomationRunConfigToExistingTask(params: {
  zcodeTaskService: AutomationDispatchTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function trackAutomationRunOutcome(params: {
  zcodeTaskService: AutomationDispatchTaskService;
  repo: AutomationDispatchRepo;
  logWarn: (message: string, error: unknown) => void;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}): void {
  const key = `${params.taskId}\u0000${params.traceId}`;
  disposeRunOutcomeSubscription(key);
  void recordCronRunOutcomeBestEffort({
    runId: params.runId,
    automationId: params.automationId,
    workspaceKey: params.workspaceKey,
    scheduledAt: params.scheduledAt,
    trigger: params.trigger,
    repo: params.repo,
    outcome: "running",
    logWarn: params.logWarn,
  });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        runId: params.runId,
        automationId: params.automationId,
        workspaceKey: params.workspaceKey,
        scheduledAt: params.scheduledAt,
        trigger: params.trigger,
        repo: params.repo,
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
        logWarn: params.logWarn,
      });
      // 定时任务在后台完成后统一置为未读，打开 task 时由导航链路清除（与桌面同款）。
      void params.zcodeTaskService
        .setTaskUnread({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          unread: true,
        })
        .catch((error) => params.logWarn("置未读失败", error));
      disposeRunOutcomeSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          automationId: params.automationId,
          runId: params.runId,
          workspaceKey: params.workspaceKey,
          repo: params.repo,
          logWarn: params.logWarn,
        })
      : null;
  runOutcomeSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * 把一次 cron/manual run 提交给本 Core 的 task service。
 * 会话内 automation 可能绑定到非激活 session，必须先恢复再应用保存的运行参数。
 */
export async function dispatchAutomationRun(params: {
  request: AutomationDispatchRequest;
  repo: AutomationDispatchRepo;
  zcodeTaskService: AutomationDispatchTaskService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  logWarn: (message: string, error: unknown) => void;
}): Promise<{ taskId: string }> {
  const { request } = params;
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: request.workspacePath,
    workspaceIdentity: request.workspaceIdentity,
  });
  // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
  // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
  const existingRun = await params.repo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection ?? undefined,
    modelSelectionService: params.modelSelectionService,
    readSelection: () =>
      params.repo.getModelSelectionForDispatch(request.automationId, workspaceKey),
  });
  const submissionModelSelection = await params.repo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
  // CLI 无法从 inputId 还原 manual/schedule admission。建会话 trace 与执行 runId
  // 是两种身份；prompt trace 统一使用 runId（桌面同款依据）。
  const promptTraceId = request.runId as TraceId;
  let trackedKey: string | null = null;
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await params.zcodeTaskService.createTask({
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          model: formatModelPickerValue(submissionModelSelection),
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          ...(request.mode ? { mode: request.mode.trim() as ZCodeTaskMode } : {}),
          automationId: request.automationId,
        });
    if (request.targetTaskId) {
      // 绑定会话在 Core 重启或切换 workspace 后通常不处于 active；直接 setConfig/sendPrompt
      // 会立即报 Session is not active，必须先恢复再应用保存的运行参数。
      await params.zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyAutomationRunConfigToExistingTask({
        zcodeTaskService: params.zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    trackAutomationRunOutcome({
      zcodeTaskService: params.zcodeTaskService,
      repo: params.repo,
      logWarn: params.logWarn,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt: request.scheduledAt,
      trigger: request.trigger,
    });
    trackedKey = `${task.taskId}\u0000${promptTraceId}`;
    await params.zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      // daemon 拓扑唯一观察面是 Web（Core /ws 固定 web-remote-replayable 档）；后台无人
      // 观察的定时运行本质是事后回放场景。grill 决策采用 replayable，与桌面派发的
      // desktop-continuous 实时链路明确区分（AGENTS.md 双链路语义边界）。
      clientMode: "web-remote-replayable",
      automationId: request.automationId,
    });
    return { taskId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeRunOutcomeSubscription(trackedKey);
    // 派发失败：回写 run outcome=failed（best-effort）。dispatch_status 与 automation
    // 重试 / manual claim 释放由调度器结算层负责（桌面同款两层边界），这里不越权。
    await recordCronRunOutcomeBestEffort({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt: request.scheduledAt,
      trigger: request.trigger,
      repo: params.repo,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      logWarn: params.logWarn,
    });
    throw error;
  }
}
