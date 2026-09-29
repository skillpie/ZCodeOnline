import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffDelayMs, createAutoReconnect } from "../src/tunnel/autoReconnect.js";

// 浏览器隧道自动重连调度器验收：指数退避序列、pending 合并、尝试上限与
// give-up 后计数清零、clear 清理待执行定时器。定时器注入手动驱动，不依赖真实时间。

/** 手动驱动的假定时器：记录排定的延迟，按需触发到点的回调。 */
function createFakeTimers() {
  const scheduled: Array<{ handle: number; delayMs: number; handler: () => void }> = [];
  let nextHandle = 1;
  return {
    scheduled,
    setTimer: (handler: () => void, ms: number): unknown => {
      const handle = nextHandle++;
      scheduled.push({ handle, delayMs: ms, handler });
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      const index = scheduled.findIndex((entry) => entry.handle === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
    /** 触发延迟最短的待执行定时器（不存在时失败）。 */
    fireNext(): void {
      assert.ok(scheduled.length > 0, "没有待触发的定时器");
      let earliest = 0;
      for (let i = 1; i < scheduled.length; i++) {
        if (scheduled[i].delayMs < scheduled[earliest].delayMs) earliest = i;
      }
      const [entry] = scheduled.splice(earliest, 1);
      entry.handler();
    },
  };
}

test("退避延迟按倍增序列计算并封顶", () => {
  assert.equal(backoffDelayMs(1, 1_000, 30_000), 1_000);
  assert.equal(backoffDelayMs(2, 1_000, 30_000), 2_000);
  assert.equal(backoffDelayMs(3, 1_000, 30_000), 4_000);
  assert.equal(backoffDelayMs(5, 1_000, 30_000), 16_000);
  assert.equal(backoffDelayMs(6, 1_000, 30_000), 30_000);
  assert.equal(backoffDelayMs(10, 1_000, 30_000), 30_000);
});

test("schedule → 到点触发 onRetry；pending 期间重复调用合并为一次", () => {
  const timers = createFakeTimers();
  let retries = 0;
  const controller = createAutoReconnect({
    maxAttempts: 6,
    initialMs: 1_000,
    maxMs: 30_000,
    onRetry: () => {
      retries += 1;
    },
    onGiveUp: () => assert.fail("不应触发 onGiveUp"),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.schedule();
  assert.equal(controller.pending, true);
  assert.equal(controller.attempt, 1);
  // 断开回调与失败路径先后到达：只保留一次重试。
  controller.schedule();
  controller.schedule();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.delayMs, 1_000);

  timers.fireNext();
  assert.equal(retries, 1);
  assert.equal(controller.pending, false);
});

test("连续失败按 1/2/4 退避，超过上限交还手动并清零计数", () => {
  const timers = createFakeTimers();
  let retries = 0;
  let giveUps = 0;
  const controller = createAutoReconnect({
    maxAttempts: 3,
    initialMs: 1_000,
    maxMs: 30_000,
    onRetry: () => {
      retries += 1;
    },
    onGiveUp: () => {
      giveUps += 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.schedule();
  assert.equal(timers.scheduled[0]?.delayMs, 1_000);
  timers.fireNext();
  controller.schedule();
  assert.equal(timers.scheduled[0]?.delayMs, 2_000);
  timers.fireNext();
  controller.schedule();
  assert.equal(timers.scheduled[0]?.delayMs, 4_000);
  timers.fireNext();
  assert.equal(retries, 3);

  // 第 4 次失败到达：窗口耗尽，交还手动；计数清零让下次从第 1 次退避重新开始。
  controller.schedule();
  assert.equal(giveUps, 1);
  assert.equal(controller.attempt, 0);
  assert.equal(controller.pending, false);
  controller.schedule();
  assert.equal(controller.attempt, 1);
  assert.equal(timers.scheduled[0]?.delayMs, 1_000);
});

test("clear 清掉待执行定时器并清零计数（连接成功/手动重连路径）", () => {
  const timers = createFakeTimers();
  let retries = 0;
  const controller = createAutoReconnect({
    maxAttempts: 6,
    initialMs: 1_000,
    maxMs: 30_000,
    onRetry: () => {
      retries += 1;
    },
    onGiveUp: () => assert.fail("不应触发 onGiveUp"),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.schedule();
  controller.schedule();
  assert.equal(controller.pending, true);
  controller.clear();
  assert.equal(controller.pending, false);
  assert.equal(controller.attempt, 0);
  assert.equal(timers.scheduled.length, 0);
  assert.equal(retries, 0);

  // 清零后重新从第 1 次退避开始。
  controller.schedule();
  assert.equal(controller.attempt, 1);
  assert.equal(timers.scheduled[0]?.delayMs, 1_000);
});
