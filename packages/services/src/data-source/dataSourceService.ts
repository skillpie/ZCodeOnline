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
  DataSourceNotesResult,
  DataSourceSchemaSnapshot,
  DataSourceTestResult,
} from "@zcode/shared";
import { maskDataSource, normalizeDataSourceInput } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { executeStatements, introspect, testConnection } from "./dbDriver.js";
import { loadDataSourceConfigFile, saveDataSourceConfigFile } from "./dataSourceConfigFile.js";
import {
  deleteDataSourceNotesFile,
  readDataSourceNotesFile,
  writeDataSourceNotesFile,
} from "./dataSourceNotes.js";
import {
  deleteSessionDataSourceBinding as deleteSessionDataSourceBindingFile,
  deleteSessionDataSourceBindingsForDataSource,
  readSessionDataSourceBinding as readSessionDataSourceBindingFile,
  writeSessionDataSourceBinding as writeSessionDataSourceBindingFile,
} from "./sessionDataSourceBinding.js";
import {
  invalidateSchemaCache,
  readSchemaSnapshot,
  writeSchemaSnapshot,
} from "./dataSourceSchemaCache.js";
import type { IDataSourceService } from "./dataSource.js";

const log = createServiceLogger("data-source");

/** 同一数据源的内省去重：进行中时复用同一 Promise（覆盖式同步，最后完成者为准）。 */
const inflightSyncs = new Map<string, Promise<DataSourceSchemaSnapshot>>();

/** 激活路径专用：只返回缓存的快照（无缓存为 null），不做内省、不走网络。 */
async function syncOrCollectErrorSnapshotOnly(
  config: DataSourceConfig,
  activeId: string | null,
): Promise<DataSourceMutationResult> {
  const schema = await readSchemaSnapshot(config.id);
  return { dataSource: maskDataSource(config), activeId, schema, syncError: null };
}

async function upsertDataSource(input: DataSourceInput): Promise<
  | {
      ok: true;
      config: DataSourceConfig;
      created: boolean;
      activeId: string | null;
    }
  | { ok: false; error: string }
> {
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
      // 手册是人工知识，删源时一并清理防孤儿（对秤 schema-cache 的清理语义）。
      await deleteDataSourceNotesFile(id);
      // 指向被删源的会话绑定一并清理：悬挂绑定在门控回退处按未选择处理，但留着
      // 会让绑定表累积不可恢复的死引用。
      await deleteSessionDataSourceBindingsForDataSource(id);
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
      // 用户决策：选中立即返回缓存的表结构快照（远端 SSH 场景全库内省 + 大快照
      // 传输要数秒，不能阻塞选中）；内省挪到后台执行，完成后快照文件自动更新，
      // 管理面板/缓存读取即可见。显式刷新走「同步表结构」按钮（syncSchema）。
      void syncSchemaOf(target)
        .then(() => log.info("background schema synced", id))
        .catch((error) =>
          log.warn(
            "background schema sync failed",
            id,
            error instanceof Error ? error.message : String(error),
          ),
        );
      return syncOrCollectErrorSnapshotOnly(target, id);
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

    async getDataSourceNotes(id): Promise<DataSourceNotesResult> {
      return readDataSourceNotesFile(id);
    },

    async saveDataSourceNotes({ id, content }): Promise<void> {
      await writeDataSourceNotesFile(id, content);
      log.info(
        "data source notes saved",
        id,
        content?.trim() ? `${content.length} chars` : "cleared",
      );
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

    async getSessionDataSourceBinding({ sessionId }): Promise<{
      dataSourceId: string | null;
    }> {
      return { dataSourceId: await readSessionDataSourceBindingFile(sessionId) };
    },

    async setSessionDataSourceBinding({ sessionId, dataSourceId }): Promise<void> {
      await writeSessionDataSourceBindingFile(sessionId, dataSourceId);
      log.info("session binding updated", sessionId, dataSourceId ?? "cleared");
    },

    async deleteSessionDataSourceBinding({ sessionId }): Promise<void> {
      await deleteSessionDataSourceBindingFile(sessionId);
      log.info("session binding deleted", sessionId);
    },
  };
  return service;
}
