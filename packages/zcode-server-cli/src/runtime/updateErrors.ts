export function updateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 运行任务守卫的错误文案是 CLI（--force 提示）与自动更新调度器共用的唯一判定依据：
// applyUpdate 抛出该错误时 pending 必须保留，等待空闲后重试而不是清理。
const RUNNING_TASK_UPDATE_GUARD_MESSAGE = "Running tasks require --force for update";

export function isRunningTaskUpdateGuardError(error: unknown): boolean {
  return updateErrorMessage(error).includes(RUNNING_TASK_UPDATE_GUARD_MESSAGE);
}

// Supervisor.applyUpdate 回滚指针恢复失败时抛 createRollbackFailure；此时状态已落
// stop-failed，磁盘事务交由人工处理，自动更新侧不得再动 pending。
export function isRollbackPointerRestoreFailure(error: unknown): boolean {
  return updateErrorMessage(error).includes("rollback pointer restore failed");
}

export function createRollbackFailure(original: unknown, rollback: unknown): Error {
  const originalMessage = updateErrorMessage(original);
  const rollbackMessage = updateErrorMessage(rollback);
  return new Error(
    `Update failed: ${originalMessage}; rollback pointer restore failed: ${rollbackMessage}`,
    { cause: rollback },
  );
}
