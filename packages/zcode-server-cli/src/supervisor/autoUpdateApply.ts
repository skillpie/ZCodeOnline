import {
  isRollbackPointerRestoreFailure,
  isRunningTaskUpdateGuardError,
} from "../runtime/updateErrors.js";
import type { ReleaseManifest } from "../contracts.js";

interface ApplyPreparedReleaseDeps {
  readPending: () => Promise<ReleaseManifest | null>;
  removePending: () => Promise<void>;
  apply: () => Promise<unknown>;
}

/**
 * 自动更新调度器的应用入口：复用 Supervisor 的 update 事务，并在事务失败（回滚已成功）
 * 后条件清理 pending，避免每个周期都对同一个坏 release 反复执行 stop/relaunch。
 *
 * 清理边界：
 * - running-task 守卫拒绝 → pending 保留（等待空闲重试）；
 * - 回滚指针恢复失败（stop-failed）→ 磁盘事务留待人工，不动任何状态；
 * - 其他失败（新 release 启动失败等，回滚已成功）→ 仅当 pending 仍指向本次尝试的
 *   版本时移除，避免误删并发手动 `zcode update` 刚准备好的另一个版本。
 */
export async function applyPreparedReleaseWithCleanup(
  deps: ApplyPreparedReleaseDeps,
): Promise<void> {
  const attempted = await deps.readPending();
  try {
    await deps.apply();
  } catch (error) {
    if (isRunningTaskUpdateGuardError(error) || isRollbackPointerRestoreFailure(error)) throw error;
    const current = await deps.readPending();
    if (current && attempted && current.version === attempted.version) {
      await deps.removePending();
    }
    throw error;
  }
}
