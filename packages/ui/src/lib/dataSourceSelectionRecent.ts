// 数据源「会话级选择」的项目级记忆（specs/data-source.md §7.1；用户决策改为按项目记忆）。
// dataSourceId 本体随 composer 草稿 per-scope 持久化，但草稿 promote 到真实会话后
// Root scope 被清空，新对话无从继承；本模块补一层偏好记忆，记录最后
// 一次显式选择/取消的结果，供 initializeNewTaskDraft 恢复初始勾选。
// v2 记忆粒度按项目：同一项目下的所有会话共享选择（切换会话互相同步）；
// 未归属项目的 workspace 回退按工作区隔离（v1 按 workspace 记忆的 key 不迁移，等同重新开始）。
import { logger } from "@/logger.js";

const DATA_SOURCE_SELECTION_RECENT_KEY_PREFIX = "zcode-datasource-selection-recent-v2";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 记忆 key：有项目归属（来自 ProjectDirectoryProvider 项目树按目录解析）时按项目
 * 共享；未归属项目时按工作区隔离。
 */
export function resolveDataSourceSelectionRecentKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  projectId?: string | null,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return projectId
    ? `${DATA_SOURCE_SELECTION_RECENT_KEY_PREFIX}:project:${projectId}`
    : `${DATA_SOURCE_SELECTION_RECENT_KEY_PREFIX}:workspace:${workspaceKey}`;
}

/**
 * 读取该项目（或未归属 workspace）上一次显式选择的数据源 id；null = 未选择
 * （含取消记忆、无记录与坏数据——三者对新对话的行为一致：不预填）。
 */
export function readDataSourceSelectionRecent(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  projectId?: string | null,
  storage: StorageLike | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(
      resolveDataSourceSelectionRecentKey(workspacePath, workspaceIdentity, projectId),
    );
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const dataSourceId = (record as { dataSourceId?: unknown }).dataSourceId;
    return typeof dataSourceId === "string" && dataSourceId ? dataSourceId : null;
  } catch {
    return null;
  }
}

/** 显式选择/取消（null）都覆盖写入；偏好记录失败只降级，不阻断会话级选择。 */
export function writeDataSourceSelectionRecent(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  dataSourceId: string | null,
  projectId?: string | null,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      resolveDataSourceSelectionRecentKey(workspacePath, workspaceIdentity, projectId),
      JSON.stringify({ dataSourceId: dataSourceId || null }),
    );
  } catch (error) {
    logger.warn("[DataSourceSelectionRecent] 保存数据源选择偏好失败", {
      workspacePath,
      workspaceIdentity,
      projectId: projectId ?? null,
      error,
    });
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
