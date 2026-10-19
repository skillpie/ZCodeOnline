/**
 * worktree 项目的命名：分支名 `feat/{6位随机数}`（如 `feat/123456`）进 MR、给协作方看。
 * worktree 目录名不再显式指定，由服务端按「目录名 = 净化分支名」约定从分支名派生为
 * `feat-{同6位随机数}`（如 `feat-123456`），与「以既有分支建 worktree」共用同一条命名规则。
 * 共享后缀让「MR 分支 ↔ worktree 目录」双向可溯；随机数避免语义命名负担，撞名自动重摇。
 */

/** worktree 分支默认命名；与已有分支撞名时重摇（最多 50 次）。 */
export function buildWorktreeBranchName(existingBranchNames: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = String(100000 + Math.floor(Math.random() * 900000));
    const branchName = `feat/${suffix}`;
    if (!existingBranchNames.has(branchName)) {
      return branchName;
    }
  }
  return `feat/${Date.now()}`;
}
