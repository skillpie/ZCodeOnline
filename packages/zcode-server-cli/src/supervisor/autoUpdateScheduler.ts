import { createServiceLogger } from "@zcode/services/node";
import { isRunningTaskUpdateGuardError } from "../runtime/updateErrors.js";
import type { AutoUpdateSettings } from "../runtime/autoUpdateConfig.js";

const log = createServiceLogger("server-auto-update");

export interface AutoUpdateCheckResult {
  status: "up-to-date" | "prepared" | "prepared-offline";
  version: string;
}

interface AutoUpdateSchedulerOptions {
  settings: AutoUpdateSettings;
  /** 拉取 catalog 并准备 pending 发行（下载落盘），不做任何生命周期切换。 */
  check: () => Promise<AutoUpdateCheckResult>;
  /** 是否满足应用条件：Core ready、无运行任务、无进行中的 lifecycle 操作。 */
  canApply: () => boolean;
  /** 走 Supervisor 的 update 事务路径（含回滚与失败清理）；被守卫拒绝时抛 running-task 错误。 */
  apply: () => Promise<unknown>;
  random?: () => number;
}

/**
 * 宿主 daemon 自动更新的定时触发器（specs/web-tunnel.md 更新器 M4）。
 *
 * 职责边界：只负责"何时检查、何时应用"；更新事务、指针与生命周期门全部归
 * Supervisor/ReleaseManager 所有。每个 tick 的事件顺序：
 *   guard（启用/未在途）→ check（联网准备）→ canApply 时 apply（空闲才切换）
 *   → 无论结果如何重排下一次定时。tick 之间不允许并发，check 期间的定时到达直接跳过。
 */
export class AutoUpdateScheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;

  public constructor(private readonly options: AutoUpdateSchedulerOptions) {}

  public start(): void {
    if (!this.options.settings.enabled || this.stopped) return;
    this.stopped = false;
    this.schedule(this.options.settings.initialDelayMs);
    log.info("auto-update scheduler started", {
      catalogUrl: this.options.settings.catalogUrl,
      initialDelayMs: this.options.settings.initialDelayMs,
      intervalMs: this.options.settings.intervalMs,
    });
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(baseDelayMs: number): void {
    if (this.stopped) return;
    const jitter = Math.floor(
      (this.options.random ?? Math.random)() * this.options.settings.maxJitterMs,
    );
    this.timer = setTimeout(() => void this.tick(), baseDelayMs + jitter);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.options.check();
      if (result.status === "up-to-date") {
        log.debug("auto-update check: up to date", { version: result.version });
        return;
      }
      if (result.status === "prepared-offline") {
        log.info("auto-update found offline pending release", { version: result.version });
      } else {
        log.info("auto-update prepared new release", { version: result.version });
      }
      // prepared-offline 同样来自既有 pending，可进入空闲应用判断。
      if (!this.options.canApply()) {
        log.info("auto-update waiting for idle to apply release", { version: result.version });
        return;
      }
      try {
        await this.options.apply();
        log.info("auto-update applied release", { version: result.version });
      } catch (error) {
        if (isRunningTaskUpdateGuardError(error)) {
          // apply 前夕出现新任务：pending 保留，下个 tick 空闲时再应用。
          log.info("auto-update deferred: tasks started before apply", {
            version: result.version,
          });
          return;
        }
        // 非 guard 失败（含回滚成功后的坏 release）：pending 清理已在 apply 依赖内
        // 按条件完成，这里只留 warn 排障痕迹。
        log.warn("auto-update failed to apply release", error);
      }
    } catch (error) {
      // 网络抖动、catalog 暂时缺失等可恢复异常：warn 留痕，等待下个 tick。
      log.warn("auto-update check failed", error);
    } finally {
      this.ticking = false;
      if (!this.stopped) this.schedule(this.options.settings.intervalMs);
    }
  }
}
