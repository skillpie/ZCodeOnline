/**
 * 表结构快照缓存：进程内存 → 磁盘（data-sources/schema-cache/<id>.json）两级。
 * 移植自 fengqun-dba `src/main/schema.js`（去掉提示词渲染；语义层/记忆不迁移）：
 * - 同步时机由 IDataSourceService 决定：添加/切换自动同步、手动强制同步；读取只碰缓存
 * - 失效：删除数据源时连内存带磁盘一起清
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataSourceSchemaSnapshot, DataSourceTable } from "@zcode/shared";
import { getDataSourceDataDir } from "./dataSourceConfigFile.js";

// v2：v1 缓存因 mysql2 元组未解构导致表/字段名为空，加载时自动失效重建
const CACHE_VERSION = 2;

interface MemoryEntry {
  tables: DataSourceTable[];
  fetchedAt: string;
}

const memory = new Map<string, MemoryEntry>();

function getSchemaCacheDir(): string {
  return join(getDataSourceDataDir(), "schema-cache");
}

function cacheFileFor(dataSourceId: string): string {
  const safeId = String(dataSourceId).replace(/[^\w-]/g, "_");
  return join(getSchemaCacheDir(), `${safeId}.json`);
}

function toSnapshot(
  dataSourceId: string,
  tables: DataSourceTable[],
  fetchedAt: string,
): DataSourceSchemaSnapshot {
  return { dataSourceId, fetchedAt, tables };
}

/** 读取缓存快照（内存优先；未命中读磁盘）。不触发数据库内省。 */
export async function readSchemaSnapshot(
  dataSourceId: string,
): Promise<DataSourceSchemaSnapshot | null> {
  const inMemory = memory.get(dataSourceId);
  if (inMemory) {
    return toSnapshot(dataSourceId, inMemory.tables, inMemory.fetchedAt);
  }
  try {
    const raw = JSON.parse(await readFile(cacheFileFor(dataSourceId), "utf-8")) as {
      version?: number;
      fetchedAt?: string;
      tables?: DataSourceTable[];
    } | null;
    if (raw && raw.version === CACHE_VERSION && Array.isArray(raw.tables)) {
      const entry: MemoryEntry = { tables: raw.tables, fetchedAt: raw.fetchedAt ?? "" };
      memory.set(dataSourceId, entry);
      return toSnapshot(dataSourceId, raw.tables, entry.fetchedAt || new Date(0).toISOString());
    }
  } catch {
    // 无缓存/版本不符/损坏 → 未命中
  }
  return null;
}

/** 覆盖写两级缓存。 */
export async function writeSchemaSnapshot(
  dataSourceId: string,
  tables: DataSourceTable[],
): Promise<DataSourceSchemaSnapshot> {
  const fetchedAt = new Date().toISOString();
  memory.set(dataSourceId, { tables, fetchedAt });
  try {
    await mkdir(getSchemaCacheDir(), { recursive: true });
    await writeFile(
      cacheFileFor(dataSourceId),
      JSON.stringify({ version: CACHE_VERSION, fetchedAt, tables }, null, 2),
      "utf-8",
    );
  } catch {
    // 落盘失败静默降级：内存缓存仍然可用，不影响主流程
  }
  return toSnapshot(dataSourceId, tables, fetchedAt);
}

/** 删除指定数据源的缓存（内存 + 磁盘）。 */
export async function invalidateSchemaCache(dataSourceId: string): Promise<void> {
  memory.delete(dataSourceId);
  try {
    await rm(cacheFileFor(dataSourceId), { force: true });
  } catch {
    // 不存在即忽略
  }
}
