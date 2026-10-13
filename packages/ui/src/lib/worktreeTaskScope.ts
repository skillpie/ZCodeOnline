import type { ZCodeTaskMeta } from "@zcode/shared";

/** worktree 工作目录标识：主树 `.worktrees/` 下的目录。 */
export interface WorktreeDirRef {
  dirName: string;
  path: string;
}

/** 单个工作区的任务查询 scope。 */
export interface WorkspaceTaskScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

/**
 * 判断任务是否属于主工作区下的某个 git worktree（`<主树>/.worktrees/<目录名>`）。
 * 双分隔符兼容（Windows 反斜杠 / 尾部斜杠）；跨 realpath 形态时以 `.worktrees/`
 * 路径段存在为准。
 */
export function isWorktreeOwnedTaskPath(taskWorkspacePath: string, workspacePath: string): boolean {
  const normalizedTask = normalizeWorkspacePath(taskWorkspacePath);
  const normalizedBase = normalizeWorkspacePath(workspacePath);
  if (normalizedTask === normalizedBase) {
    return false;
  }

  const worktreeMarker = "/.worktrees/";
  const markerIndex = normalizedTask.indexOf(worktreeMarker);
  if (markerIndex < 0) {
    return false;
  }
  // `.worktrees/` 段必须落在主工作区路径之内（前缀匹配），避免把
  // 「路径里恰好含 .worktrees 字样的无关目录」误判为当前工作区的 worktree。
  return normalizedTask.startsWith(`${normalizedBase}/`);
}

/** worktree 所在仓库的主树工作区路径（`.worktrees/` 前段）；非 worktree 路径原样返回。 */
export function mainWorkspacePathOf(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  const markerIndex = normalized.indexOf("/.worktrees/");
  return markerIndex > 0 ? normalized.slice(0, markerIndex) : workspacePath;
}

/** worktree 目录名（路径末段），同时是创建时副本分支的净化名。 */
export function worktreeDirNameOf(taskWorkspacePath: string): string {
  const segments = normalizeWorkspacePath(taskWorkspacePath).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? taskWorkspacePath;
}

/**
 * 把主工作区的任务查询 scope 扩展为「主 scope + 其 `.worktrees/*` worktree scope」。
 * worktree 会话仍归属各自 workspaceKey，只是查询聚合跨 scope。
 */
export function expandWorkspaceTaskScopes(
  baseScope: WorkspaceTaskScope,
  worktreeDirs: readonly WorktreeDirRef[],
): WorkspaceTaskScope[] {
  const scopes: WorkspaceTaskScope[] = [baseScope];
  for (const dir of worktreeDirs) {
    if (
      scopes.some(
        (scope) => normalizeWorkspacePath(scope.workspacePath) === normalizeWorkspacePath(dir.path),
      )
    ) {
      continue;
    }
    scopes.push({ workspacePath: dir.path });
  }
  return scopes;
}
