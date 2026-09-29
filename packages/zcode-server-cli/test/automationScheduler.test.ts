import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AutomationRepo } from "@zcode/services/node";
import type { ModelSelection } from "@zcode/shared";
import {
  startAutomationScheduler,
  type AutomationDispatchTargets,
} from "../src/server-core/automationScheduler.js";

// daemon 侧 cron automation 调度循环验收：
// 到点派发推进 / misfire 跳过与一次性终态 / 失败退避重试复用 runId /
// 双调度器共享同库认领互斥（桌面 + daemon 并存不重复执行）/ manual run 失败释放 single-flight /
// dispose 释放在途认领。语义基准为桌面 packages/desktop/src/scheduler。

type TerminalResult = {
  taskId: string;
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  error?: string;
};

function createFakeTargets() {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const terminalListeners = new Map<string, (result: TerminalResult) => void>();
  let sendPromptGate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  const selection: ModelSelection = {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "medium" },
  };
  const targets: AutomationDispatchTargets = {
    modelSelectionService: {
      getView: async (input?: { selection: ModelSelection | null }) => {
        const effective = input?.selection ?? selection;
        return {
          revision: 0,
          providers: [],
          effectiveSelection: effective,
          preferredSelection: selection,
        };
      },
    },
    zcodeTaskService: {
      createTask: async (params) => {
        calls.push({ op: "createTask", params: params as Record<string, unknown> });
        return { taskId: `task-${calls.length}` };
      },
      resumeTask: async (params) => {
        calls.push({ op: "resumeTask", params: params as Record<string, unknown> });
      },
      setAutomationSessionConfig: async (params) => {
        calls.push({ op: "setAutomationSessionConfig", params: params as Record<string, unknown> });
      },
      setConfigOption: async (params) => {
        calls.push({ op: "setConfigOption", params: params as Record<string, unknown> });
      },
      sendPrompt: async (params) => {
        calls.push({ op: "sendPrompt", params: params as Record<string, unknown> });
        if (sendPromptGate) await sendPromptGate;
      },
      setTaskUnread: async (params) => {
        calls.push({ op: "setTaskUnread", params: params as Record<string, unknown> });
      },
      onDynamicTaskTerminalOutcome:
        (taskId: string) => (listener: (result: TerminalResult) => void) => {
          terminalListeners.set(taskId, listener);
          return { dispose: () => terminalListeners.delete(taskId) };
        },
    },
  };
  return {
    targets,
    calls,
    terminalListeners,
    selection,
    /** 让 sendPrompt 挂起以制造在途派发；release 后继续执行。 */
    holdSendPrompt(): { release(): void } {
      sendPromptGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return { release: () => releaseGate?.() };
    },
    failSendPromptOnce(message: string): void {
      const original = targets.zcodeTaskService.sendPrompt;
      targets.zcodeTaskService.sendPrompt = async (params) => {
        targets.zcodeTaskService.sendPrompt = original;
        calls.push({ op: "sendPrompt", params: params as Record<string, unknown> });
        if (sendPromptGate) await sendPromptGate;
        throw new Error(message);
      };
    },
  };
}

async function createTempRepo(): Promise<AutomationRepo> {
  const dir = await mkdtemp(join(tmpdir(), "automation-scheduler-"));
  return new AutomationRepo(join(dir, "tasks-index.db"));
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const WORKSPACE = "/ws/demo";

test("到期任务到点派发：runId 用 next_run_at，clientMode 为 web-remote-replayable，推进 next_run_at 与计数", async () => {
  const repo = await createTempRepo();
  const fake = createFakeTargets();
  const dueAt = 1_700_000_060_000;
  const automation = await repo.create(
    {
      title: "定时汇报",
      cronExpr: "* * * * *",
      prompt: "hello",
      workspacePath: WORKSPACE,
      recurring: true,
    },
    { nextRunAt: dueAt },
  );
  let clock = dueAt + 1_000;
  const scheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  });
  await scheduler.tick();
  await waitFor(() => fake.calls.some((call) => call.op === "sendPrompt"));

  const sendPrompt = fake.calls.find((call) => call.op === "sendPrompt")?.params;
  assert.ok(sendPrompt);
  assert.equal(sendPrompt.content, "hello");
  // grill 决策：daemon 派发统一走 web-remote-replayable（事后回放语义），与桌面 continuous 区分。
  assert.equal(sendPrompt.clientMode, "web-remote-replayable");
  assert.equal(sendPrompt.automationId, automation.automationId);
  // prompt trace = runId = automationId:scheduledAt（scheduledAt 取 next_run_at）。
  assert.equal(sendPrompt.traceId, `${automation.automationId}:${dueAt}`);
  const createTask = fake.calls.find((call) => call.op === "createTask")?.params;
  assert.ok(createTask);
  assert.equal(createTask.automationId, automation.automationId);
  assert.equal(createTask.workspacePath, WORKSPACE);

  await waitFor(async () => (await repo.get(automation.automationId))?.runCount === 1);
  const after = await repo.get(automation.automationId);
  assert.ok(after);
  assert.equal(after.enabled, true);
  assert.ok(after.nextRunAt != null && after.nextRunAt > dueAt, "next_run_at 应推进到未来");
  const run = await repo.getRun(`${automation.automationId}:${dueAt}`);
  assert.equal(run?.dispatchStatus, "dispatched");
  await scheduler.dispose();
});

test("misfire：错过窗口的循环任务记 skipped 并重排，不执行", async () => {
  const repo = await createTempRepo();
  const fake = createFakeTargets();
  const dueAt = 1_700_000_060_000;
  const automation = await repo.create(
    {
      title: "错过窗口",
      cronExpr: "* * * * *",
      prompt: "hello",
      workspacePath: WORKSPACE,
      recurring: true,
    },
    { nextRunAt: dueAt },
  );
  const clock = dueAt + 6 * 60_000; // 超过 5 分钟 misfire 宽限
  const scheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  });
  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(
    fake.calls.some((call) => call.op === "sendPrompt"),
    false,
    "misfire 不应派发",
  );
  const after = await repo.get(automation.automationId);
  assert.ok(after);
  assert.equal(after.dispatchAttempts, 0);
  assert.ok(after.nextRunAt != null && after.nextRunAt > clock, "应重排到未来窗口");
  const runs = await repo.listRuns(after.automationId);
  assert.equal(runs[0]?.dispatchStatus, "skipped");
  await scheduler.dispose();
});

test("misfire：一次性任务错过窗口即终态，不再排程", async () => {
  const repo = await createTempRepo();
  const fake = createFakeTargets();
  const dueAt = 1_700_000_060_000;
  const automation = await repo.create(
    {
      title: "一次性提醒",
      cronExpr: "* * * * *",
      prompt: "once",
      workspacePath: WORKSPACE,
      recurring: false,
      maxRuns: 1,
    },
    { nextRunAt: dueAt },
  );
  const clock = dueAt + 6 * 60_000;
  const scheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  });
  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = await repo.get(automation.automationId);
  assert.ok(after);
  assert.equal(after.lifecycleStatus, "completed");
  assert.equal(after.enabled, false);
  // DB NULL 在 rowToAutomation 里映射为 undefined，断言用宽松判空。
  assert.ok(after.nextRunAt == null, "一次性任务错过即终态，不应再有 next_run_at");
  assert.equal(
    fake.calls.some((call) => call.op === "sendPrompt"),
    false,
  );
  await scheduler.dispose();
});

test("派发失败退避重试：transient 写 retry_at，重试复用同一 runId", async () => {
  const repo = await createTempRepo();
  const fake = createFakeTargets();
  const dueAt = 1_700_000_060_000;
  const automation = await repo.create(
    {
      title: "失败重试",
      cronExpr: "* * * * *",
      prompt: "retry me",
      workspacePath: WORKSPACE,
      recurring: true,
    },
    { nextRunAt: dueAt },
  );
  let clock = dueAt + 1_000;
  fake.failSendPromptOnce("send boom");
  const scheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  });
  await scheduler.tick();
  const failedRunId = `${automation.automationId}:${dueAt}`;
  await waitFor(
    async () => (await repo.getRun(failedRunId))?.dispatchStatus === "failed_to_dispatch",
  );

  const afterFail = await repo.get(automation.automationId);
  assert.ok(afterFail);
  assert.equal(afterFail.dispatchAttempts, 1);
  assert.ok(afterFail.retryAt != null, "transient 失败应写退避 retry_at");

  // 推进时钟越过 retry_at：按 retry 分支认领，scheduledAt 取不变的 next_run_at → 同一 runId。
  clock = (afterFail.retryAt ?? 0) + 1_000;
  await scheduler.tick();
  await waitFor(async () => (await repo.getRun(failedRunId))?.dispatchStatus === "dispatched");
  const runs = await repo.listRuns(automation.automationId);
  assert.equal(runs.length, 1, "重试必须复用同一 runId，不得新开 run");
  assert.equal(runs[0]?.dispatchStatus, "dispatched");
  const sendPromptCalls = fake.calls.filter((call) => call.op === "sendPrompt");
  assert.equal(sendPromptCalls.length, 2);
  assert.equal(sendPromptCalls[1]?.params.traceId, failedRunId);
  await scheduler.dispose();
});

test("双调度器共享同库认领互斥：桌面与 daemon 并存不会重复派发", async () => {
  const dir = await mkdtemp(join(tmpdir(), "automation-scheduler-"));
  const dbPath = join(dir, "tasks-index.db");
  const repoA = new AutomationRepo(dbPath);
  const repoB = new AutomationRepo(dbPath);
  const fake = createFakeTargets();
  const dueAt = 1_700_000_060_000;
  const automation = await repoA.create(
    {
      title: "并存互斥",
      cronExpr: "* * * * *",
      prompt: "once only",
      workspacePath: WORKSPACE,
      recurring: true,
    },
    { nextRunAt: dueAt },
  );
  const clock = dueAt + 1_000;
  const common = {
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  };
  const schedulerA = startAutomationScheduler({ repo: repoA, ...common });
  const schedulerB = startAutomationScheduler({ repo: repoB, ...common });

  const held = fake.holdSendPrompt();
  await schedulerA.tick(); // A 认领并派发，sendPrompt 挂起（在途）
  await waitFor(() => fake.calls.some((call) => call.op === "sendPrompt"));
  await schedulerB.tick(); // B 轮询同一库：running=1 不可认领
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    fake.calls.filter((call) => call.op === "sendPrompt").length,
    1,
    "同一条到期任务只能被一个调度器派发",
  );
  held.release();
  await waitFor(
    async () =>
      (await repoA.getRun(`${automation.automationId}:${dueAt}`))?.dispatchStatus === "dispatched",
  );
  await schedulerA.dispose();
  await schedulerB.dispose();
});

test("manual run 派发失败：释放 single-flight，可再次立即运行", async () => {
  const repo = await createTempRepo();
  const fake = createFakeTargets();
  const automation = await repo.create(
    {
      title: "立即运行",
      cronExpr: "* * * * *",
      prompt: "manual",
      workspacePath: WORKSPACE,
      recurring: true,
    },
    { nextRunAt: 1_700_000_060_000 },
  );
  const clock = 1_700_000_000_000;
  const scheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  });
  fake.failSendPromptOnce("manual boom");
  const claimed = await repo.runNow(automation.automationId, { now: clock });
  assert.ok(claimed);
  await scheduler.dispatchManualRun({ automation: claimed.automation, run: claimed.run });

  const failedRun = await repo.getRun(claimed.run.runId);
  assert.equal(failedRun?.dispatchStatus, "failed_to_dispatch");
  // 失败已释放 manual single-flight：再次立即运行可以重新认领。
  const reclaimed = await repo.runNow(automation.automationId, { now: clock + 1_000 });
  assert.ok(reclaimed, "失败后 manual claim 应已释放");
  await scheduler.dispose();
});

test("dispose 释放在途认领：无需等 CLAIM_STALE 即可重新派发", async () => {
  const repo = await createTempRepo();
  const fake = createFakeTargets();
  const dueAt = 1_700_000_060_000;
  await repo.create(
    {
      title: "退出释放",
      cronExpr: "* * * * *",
      prompt: "release me",
      workspacePath: WORKSPACE,
      recurring: true,
    },
    { nextRunAt: dueAt },
  );
  const clock = dueAt + 1_000;
  const scheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock,
    pollIntervalMs: 3_600_000,
  });
  const held = fake.holdSendPrompt();
  await scheduler.tick();
  await waitFor(() => fake.calls.some((call) => call.op === "sendPrompt"));

  await scheduler.dispose(); // 在途派发中退出：应释放认领
  held.release();

  // 新调度器实例（模拟进程重启）：认领不再被残留 running=1 阻塞。
  const nextScheduler = startAutomationScheduler({
    repo,
    resolveTargets: () => fake.targets,
    now: () => clock + 60_000,
    pollIntervalMs: 3_600_000,
  });
  await nextScheduler.tick();
  await waitFor(() => fake.calls.filter((call) => call.op === "sendPrompt").length >= 2);
  assert.equal(
    fake.calls.filter((call) => call.op === "createTask").length,
    2,
    "重启后重新认领并创建新会话执行",
  );
  await nextScheduler.dispose();
});
