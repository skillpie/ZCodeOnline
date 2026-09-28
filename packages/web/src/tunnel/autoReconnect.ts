// 浏览器侧隧道自动重连调度器：对齐宿主连接器（zcode-server-cli tunnelConnector）的
// 指数退避语义。只负责"何时重试"的状态机——退避序列、尝试上限、并发合并；重试动作
// 与 UI 反馈由 TunnelAppRoot 注入。独立于 React，node:test 可注入定时器直接驱动。
//
// 事件顺序（所有者 = 本调度器，重试动作 = 注入的 onRetry）：
//   断开/失败 → schedule() 排定时器（pending 期间重复调用合并为一次）
//   → 定时器到点 → onRetry() → 连接链重跑 → 成功: clear() 清零 / 失败: 再 schedule()
//   → 连续失败超过 maxAttempts → onGiveUp() 交还手动重连（计数清零，下次从 1 开始）。

export interface AutoReconnectOptions {
  /** 连续失败上限：超过后 onGiveUp。窗口需覆盖 relay 重启 + 宿主退避重连的典型恢复时长。 */
  maxAttempts: number;
  /** 首次重试延迟与延迟上限（毫秒），取值对齐 TUNNEL_CONSTANTS.reconnect*。 */
  initialMs: number;
  maxMs: number;
  /** 定时器到点：执行一次重连（调用方负责重跑连接链）。 */
  onRetry: () => void;
  /** 自动重试窗口耗尽：交还手动重连。 */
  onGiveUp: () => void;
  /** 定时器实现注入（测试用）；缺省全局 setTimeout/clearTimeout。 */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 第 attempt 次重试的退避延迟：initialMs * 2^(attempt-1)，封顶 maxMs。 */
export function backoffDelayMs(attempt: number, initialMs: number, maxMs: number): number {
  return Math.min(initialMs * 2 ** (attempt - 1), maxMs);
}

export interface AutoReconnectController {
  /** 已有待执行的重试定时器。 */
  readonly pending: boolean;
  /** 已连续失败的次数（不含待执行的那次）。 */
  readonly attempt: number;
  /** 排一次重试。 */
  schedule(): void;
  /** 连接成功或用户手动重连：清掉待执行重试并把计数清零。 */
  clear(): void;
}

export function createAutoReconnect(options: AutoReconnectOptions): AutoReconnectController {
  const setTimer =
    options.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as number));

  let attempt = 0;
  let timerHandle: unknown = null;

  return {
    get pending(): boolean {
      return timerHandle !== null;
    },
    get attempt(): number {
      return attempt;
    },
    schedule() {
      // 断开回调与失败路径可能先后到达同一结论：pending 期间合并为一次重试。
      if (timerHandle !== null) return;
      const next = attempt + 1;
      if (next > options.maxAttempts) {
        // 窗口耗尽：保留手动重连出口，计数清零让下一次手动/自动都从头开始。
        attempt = 0;
        options.onGiveUp();
        return;
      }
      attempt = next;
      const delayMs = backoffDelayMs(next, options.initialMs, options.maxMs);
      timerHandle = setTimer(() => {
        timerHandle = null;
        options.onRetry();
      }, delayMs);
    },
    clear() {
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      attempt = 0;
    },
  };
}
