// 数据源「会话级选择」的 workspace 级记忆（specs/data-source.md §7.1）。
// dataSourceId 本体随 composer 草稿 per-scope 持久化，但草稿 promote 到真实会话后
// Root scope 被清空，新对话无从继承；本模块补一层 per-workspace 偏好，记录该
// workspace 最后一次显式选择/取消的结果，供 initializeNewTaskDraft 恢复初始勾选。
// key 惯例与 composerRecent 一致：workspaceIdentity?.trim() || workspacePath，项目间天然隔离。
import { logger } from "@/logger.js";

const DATA_SOURCE_SELECTION_RECENT_KEY_PREFIX = "zcode-datasource-selection-recent-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveDataSourceSelectionRecentKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${DATA_SOURCE_SELECTION_RECENT_KEY_PREFIX}:${workspaceKey}`;
}

/**
 * 读取该 workspace 上一次显式选择的数据源 id；null = 未选择（含取消记忆、
 * 无记录与坏数据——三者对新对话的行为一致：不预填）。
 */
export function readDataSourceSelectionRecent(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(
      resolveDataSourceSelectionRecentKey(workspacePath, workspaceIdentity),
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
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      resolveDataSourceSelectionRecentKey(workspacePath, workspaceIdentity),
      JSON.stringify({ dataSourceId: dataSourceId || null }),
    );
  } catch (error) {
    logger.warn("[DataSourceSelectionRecent] 保存数据源选择偏好失败", {
      workspacePath,
      workspaceIdentity,
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
