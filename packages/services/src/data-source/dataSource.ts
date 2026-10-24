import type {
  DataSourceExecuteResult,
  DataSourceInput,
  DataSourceListResult,
  DataSourceMutationResult,
  DataSourceNotesResult,
  DataSourceSchemaSnapshot,
  DataSourceTestResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 数据源管理服务（MySQL / PostgreSQL）。
 *
 * Host 端唯一所有者：持久化数据源配置与表结构快照，执行连接测试与 SQL 读写。
 * UI 通过本接口读写，不持有第二份事实；添加/切换时自动同步一次表结构。
 */
export interface IDataSourceService {
  listDataSources(): Promise<DataSourceListResult>;
  /** 保存（新建或编辑）后自动同步一次表结构；密码留空且为编辑时保持原密码。 */
  saveDataSource(input: DataSourceInput): Promise<DataSourceMutationResult>;
  deleteDataSource(id: string): Promise<void>;
  /** 切换激活数据源，并自动同步一次表结构。 */
  activateDataSource(id: string): Promise<DataSourceMutationResult>;
  testDataSource(input: DataSourceInput): Promise<DataSourceTestResult>;
  /** 强制重新内省并覆盖表结构快照。 */
  syncSchema(id: string): Promise<DataSourceMutationResult>;
  /** 读取已缓存快照（不触发内省；未同步过返回 null）。 */
  getSchemaSnapshot(id: string): Promise<DataSourceSchemaSnapshot | null>;
  /**
   * 查数手册（人工维护的查数口径/陷阱 markdown）：落盘 data-sources/notes/<id>.md，
   * agent 侧只读同一文件并随表清单注入上下文。未编写返回 content: null。
   */
  getDataSourceNotes(id: string): Promise<DataSourceNotesResult>;
  /** 保存手册（原子写）；content 为空即清除。 */
  saveDataSourceNotes(input: { id: string; content: string | null }): Promise<void>;
  /** 核心读写引擎：只读模式拦截非查询语句；写语句统一包事务，任一失败全部回滚。 */
  executeSql(
    id: string,
    sql: string,
    options?: { maxRows?: number },
  ): Promise<DataSourceExecuteResult>;
  /**
   * 会话级数据源绑定（用户决策：宿主持久化，桌面端与 Web 端共用同一份）。
   * sessionId 全局唯一，不按 workspace 分桶（跨端 key 天然一致）。
   * 读取未绑定为 null；写入 null 清除。会话删除时调用 delete 清理，防止无限增长。
   */
  getSessionDataSourceBinding(input: { sessionId: string }): Promise<{
    dataSourceId: string | null;
  }>;
  setSessionDataSourceBinding(input: {
    sessionId: string;
    dataSourceId: string | null;
  }): Promise<void>;
  deleteSessionDataSourceBinding(input: { sessionId: string }): Promise<void>;
}

export const IDataSourceService = createServiceDescriptor<IDataSourceService>(
  ServiceChannels.DataSource,
);
