/**
 * worktree 项目的命名：`{工程名}-{4位随机数}`（如 `fengqun-scm-a3f2`）。
 * 目录名与分支名同名（目录名为分支名的净化形式），工程归属一目了然，
 * 随机数避免语义命名负担，撞名自动重摇。
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

/** worktree 项目默认名：`{工程名}-{4位随机数}`；与已有分支撞名时重摇（最多 50 次）。 */
export function buildWorktreeProjectName(
  projectPath: string,
  existingBranchNames: ReadonlySet<string>,
): string {
  const rawLeaf = projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "worktree";
  const base = sanitizeWorktreeRefSegment(rawLeaf);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `${base}-${String(1000 + Math.floor(Math.random() * 9000))}`;
    if (!existingBranchNames.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}
