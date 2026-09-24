import type {
  DataSourceExecuteResult,
  DataSourceInput,
  DataSourceListResult,
  DataSourceMutationResult,
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
  /** 核心读写引擎：只读模式拦截非查询语句；写语句统一包事务，任一失败全部回滚。 */
  executeSql(
    id: string,
    sql: string,
    options?: { maxRows?: number },
  ): Promise<DataSourceExecuteResult>;
}

export const IDataSourceService = createServiceDescriptor<IDataSourceService>(
  ServiceChannels.DataSource,
);
