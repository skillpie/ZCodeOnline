/**
 * worktree 项目的命名：目录名与分支名解耦，共用同一个 6 位随机后缀。
 * - 目录名 `{工程名}-{6位随机数}`（如 `fengqun-scm-123456`）：本地标识，只在本机展示。
 * - 分支名 `feat/{同6位随机数}`（如 `feat/123456`）：进 MR、给协作方看。
 * 共享后缀让「MR 分支 ↔ worktree 目录」双向可溯；随机数避免语义命名负担，撞名自动重摇。
 */

/** git ref 名的非法字符与需要规避的形态；工程目录名需净化后才可用作分支名。 */
export function sanitizeWorktreeRefSegment(name: string): string {
  const segments = name.replace(/\\/g, "/").split("/").filter(Boolean);
  const leaf = segments[segments.length - 1] ?? "worktree";
  const sanitized = leaf
    .replace(/[~^:?*[\]\\@{|<>"\u0000-\u001f\u007f]|@\{/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return sanitized || "worktree";
}

export interface WorktreeProjectNamePlan {
  directoryName: string;
  branchName: string;
}

/** worktree 项目默认命名；分支名与已有分支撞名时重摇（最多 50 次）。 */
export function buildWorktreeProjectName(
  projectPath: string,
  existingBranchNames: ReadonlySet<string>,
): WorktreeProjectNamePlan {
  const rawLeaf = projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "worktree";
  const base = sanitizeWorktreeRefSegment(rawLeaf);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = String(100000 + Math.floor(Math.random() * 900000));
    const branchName = `feat/${suffix}`;
    if (!existingBranchNames.has(branchName)) {
      return { directoryName: `${base}-${suffix}`, branchName };
    }
  }
  const fallbackSuffix = String(Date.now());
  return { directoryName: `${base}-${fallbackSuffix}`, branchName: `feat/${fallbackSuffix}` };
}
