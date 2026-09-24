// ============================================================
// DB Tools - data source config & schema cache access
// ============================================================
// 附加式新功能（specs/data-source.md）：数据源配置与表结构快照的唯
// 一所有者是桌面/Web host 的 IDataSourceService；agent 侧只读同一份
// 落盘文件，路径公式与 adapters/src/auth/shared-credentials.ts 一致
// （ZCODE_DATA_BASE_DIR ?? homedir() + .zcode/v2/data-sources/）。

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { DbSchemaTable, DbTargetView } from "@zcode/contracts";

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";

/** 与 host 端 dataSourceConfigFile.ts 保持一致的落盘结构。 */
interface DataSourceConfigFile {
  activeId: string | null;
  dataSources: StoredDataSourceConfig[];
}

interface StoredDataSourceConfig {
  id: string;
  type: "mysql" | "postgresql";
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  readOnly: boolean;
  createdAt: string;
}

export interface ResolvedDataSource {
  config: StoredDataSourceConfig;
  view: DbTargetView;
}

interface SchemaCacheFile {
  version: number;
  fetchedAt: string;
  tables: DbSchemaTable[];
}

/** v2 才是有效缓存（v1 因宿主侧 mysql2 元组缺陷表/字段名为空，见 specs/data-source.md）。 */
const SUPPORTED_SCHEMA_CACHE_VERSION = 2;

function resolveDataSourceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const baseDir = env[ZCODE_DATA_BASE_DIR_ENV_KEY]?.trim() || homedir();
  return join(baseDir, ".zcode", "v2", "data-sources");
}

function toView(config: StoredDataSourceConfig): DbTargetView {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    read_only: config.readOnly,
  };
}

async function readConfigFile(): Promise<DataSourceConfigFile> {
  try {
    const raw = JSON.parse(
      await readFile(join(resolveDataSourceDataDir(), "config.json"), "utf-8"),
    ) as Partial<DataSourceConfigFile> | null;
    if (!raw || !Array.isArray(raw.dataSources)) {
      return { activeId: null, dataSources: [] };
    }
    return { activeId: raw.activeId ?? null, dataSources: raw.dataSources };
  } catch {
    return { activeId: null, dataSources: [] };
  }
}

function describeAvailable(file: DataSourceConfigFile): string {
  if (file.dataSources.length === 0) {
    return "No data sources configured. Ask the user to add one in the app's Data Source panel first.";
  }
  const lines = file.dataSources.map(
    (item) =>
      `- name="${item.name}" id=${item.id} type=${item.type} host=${item.host}:${item.port}/${item.database}${item.readOnly ? " [read-only]" : " [read-write]"}`,
  );
  return `Available data sources:\n${lines.join("\n")}`;
}

/**
 * 解析目标数据源：显式名称/ID（大小写敏感）优先，其次 activeId。
 * 找不到时抛出带可用清单的错误，让模型能纠正参数。
 */
export async function resolveDataSource(target?: string): Promise<ResolvedDataSource> {
  const file = await readConfigFile();
  const picked = target
    ? file.dataSources.find((item) => item.id === target || item.name === target)
    : (file.dataSources.find((item) => item.id === file.activeId) ?? null);
  if (!picked) {
    const reason = target
      ? `Data source "${target}" not found.`
      : "No active data source selected.";
    throw new Error(`${reason} ${describeAvailable(file)}`);
  }
  return { config: picked, view: toView(picked) };
}

export async function readAvailableDataSourceSummary(): Promise<string> {
  return describeAvailable(await readConfigFile());
}

/** 读取表结构快照缓存（只读落盘文件，不触发数据库内省）。 */
export async function readSchemaCache(
  dataSourceId: string,
): Promise<{ fetchedAt: string; tables: DbSchemaTable[] } | null> {
  try {
    const safeId = String(dataSourceId).replace(/[^\w-]/g, "_");
    const raw = JSON.parse(
      await readFile(join(resolveDataSourceDataDir(), "schema-cache", `${safeId}.json`), "utf-8"),
    ) as Partial<SchemaCacheFile> | null;
    if (!raw || raw.version !== SUPPORTED_SCHEMA_CACHE_VERSION || !Array.isArray(raw.tables)) {
      return null;
    }
    return { fetchedAt: raw.fetchedAt ?? "", tables: raw.tables };
  } catch {
    return null;
  }
}
