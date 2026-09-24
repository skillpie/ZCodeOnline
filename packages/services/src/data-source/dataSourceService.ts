/**
 * IDataSourceService 实现：数据源配置 CRUD、连接测试、表结构自动同步与核心 SQL 读写。
 * 状态所有者在本服务（config.json + schema-cache），UI 仅是投影。
 */

import type {
  DataSourceConfig,
  DataSourceExecuteResult,
  DataSourceInput,
  DataSourceListResult,
  DataSourceMutationResult,
  DataSourceSchemaSnapshot,
  DataSourceTestResult,
} from "@zcode/shared";
import { maskDataSource, normalizeDataSourceInput } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { executeStatements, introspect, testConnection } from "./dbDriver.js";
import {
  loadDataSourceConfigFile,
  saveDataSourceConfigFile,
} from "./dataSourceConfigFile.js";
import {
  invalidateSchemaCache,
  readSchemaSnapshot,
  writeSchemaSnapshot,
} from "./dataSourceSchemaCache.js";
import type { IDataSourceService } from "./dataSource.js";

const log = createServiceLogger("data-source");

/** 同一数据源的内省去重：进行中时复用同一 Promise（覆盖式同步，最后完成者为准）。 */
const inflightSyncs = new Map<string, Promise<DataSourceSchemaSnapshot>>();

async function upsertDataSource(input: DataSourceInput): Promise<{
  ok: true;
  config: DataSourceConfig;
  created: boolean;
  activeId: string | null;
} | { ok: false; error: string }> {
  const file = await loadDataSourceConfigFile();
  const existing = input.id ? file.dataSources.find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) {
    return { ok: false, error: `数据源不存在：${input.id}` };
  }
  const normalized = normalizeDataSourceInput(input, existing);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  const next = existing
    ? file.dataSources.map((item) => (item.id === existing.id ? normalized.config : item))
    : [...file.dataSources, normalized.config];
  // 首个数据源自动成为激活源
  const activeId = file.activeId ?? normalized.config.id;
  await saveDataSourceConfigFile({ activeId, dataSources: next });
  return { ok: true, config: normalized.config, created: !existing, activeId };
}

async function syncSchemaOf(config: DataSourceConfig): Promise<DataSourceSchemaSnapshot> {
  const inflight = inflightSyncs.get(config.id);
  if (inflight) return inflight;
  const run = (async () => {
    try {
      const tables = await introspect(config);
      log.info("schema synced", config.id, `${tables.length} tables`);
      return await writeSchemaSnapshot(config.id, tables);
    } finally {
      inflightSyncs.delete(config.id);
    }
  })();
  inflightSyncs.set(config.id, run);
  return run;
}

/** 保存/激活后的统一收尾：自动同步一次表结构；失败不回滚主操作，错误带回给 UI。 */
async function syncOrCollectError(
  config: DataSourceConfig,
  activeId: string | null,
): Promise<DataSourceMutationResult> {
  try {
    const schema = await syncSchemaOf(config);
    return { dataSource: maskDataSource(config), activeId, schema, syncError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("schema sync failed", config.id, message);
    return { dataSource: maskDataSource(config), activeId, schema: null, syncError: message };
  }
}

export function createDataSourceService(): IDataSourceService {
  const service: IDataSourceService = {
    async listDataSources(): Promise<DataSourceListResult> {
      const file = await loadDataSourceConfigFile();
      return { dataSources: file.dataSources.map(maskDataSource), activeId: file.activeId };
    },

    async saveDataSource(input): Promise<DataSourceMutationResult> {
      const saved = await upsertDataSource(input);
      if (!saved.ok) throw new Error(saved.error);
      return syncOrCollectError(saved.config, saved.activeId);
    },

    async deleteDataSource(id: string): Promise<void> {
      const file = await loadDataSourceConfigFile();
      const next = file.dataSources.filter((item) => item.id !== id);
      if (next.length === file.dataSources.length) return;
      await saveDataSourceConfigFile({
        activeId: file.activeId === id ? null : file.activeId,
        dataSources: next,
      });
      await invalidateSchemaCache(id);
      log.info("data source deleted", id);
    },

    async activateDataSource(id): Promise<DataSourceMutationResult> {
      const file = await loadDataSourceConfigFile();
      const target = file.dataSources.find((item) => item.id === id);
      if (!target) throw new Error(`数据源不存在：${id}`);
      if (file.activeId !== id) {
        await saveDataSourceConfigFile({ ...file, activeId: id });
        log.info("data source activated", id);
      }
      return syncOrCollectError(target, id);
    },

    async testDataSource(input): Promise<DataSourceTestResult> {
      const normalized = normalizeDataSourceInput(input);
      if (!normalized.ok) return { ok: false, error: normalized.error };
      return testConnection(normalized.config);
    },

    async syncSchema(id): Promise<DataSourceMutationResult> {
      const file = await loadDataSourceConfigFile();
      const target = file.dataSources.find((item) => item.id === id);
      if (!target) throw new Error(`数据源不存在：${id}`);
      return syncOrCollectError(target, file.activeId);
    },

    async getSchemaSnapshot(id): Promise<DataSourceSchemaSnapshot | null> {
      return readSchemaSnapshot(id);
    },

    async executeSql(id, sql, options): Promise<DataSourceExecuteResult> {
      const file = await loadDataSourceConfigFile();
      const target = file.dataSources.find((item) => item.id === id);
      if (!target) throw new Error(`数据源不存在：${id}`);
      const result = await executeStatements(target, sql, {
        maxRows: options?.maxRows,
        readOnly: target.readOnly,
      });
      log.debug("executeSql", id, `ok=${String(result.ok)}`, `${result.results.length} statements`);
      return result;
    },
  };
  return service;
}
