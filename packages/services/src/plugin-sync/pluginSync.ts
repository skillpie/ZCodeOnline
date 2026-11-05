import type {
  PluginDataSyncPayload,
  PluginSyncArchiveExportResult,
  PluginSyncCandidateListResult,
  PluginSyncImportResult,
  PluginSyncMarketplaceMirrorInspection,
  PluginSyncMarketplaceSourceArchiveExportResult,
  PluginSyncMarketplaceSourceImportResult,
  PluginSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";

/**
 * 数据同步弹窗使用 IDataSyncCategoryService 的统一形状（inline 插件，key 为 `name@inline` 小写）。
 * marketplace 插件依赖 Agent RPC，编排在 Renderer 的数据同步适配层；本服务只提供来源镜像的导出、导入与预检。
 * fork 附加方法（listLocalUserPluginCandidates 等）服务旧路径 RemotePluginSyncDialog：
 * 归档式「只新增、同名跳过」语义与展示字段依赖它们；两套方法由同一实现提供。
 */
export interface IPluginSyncService extends IDataSyncCategoryService<PluginDataSyncPayload> {
  exportMarketplaceSourceArchive(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<PluginSyncMarketplaceSourceArchiveExportResult>;
  /**
   * 数据同步列表阶段：本端 Personal Source 本地目录类 marketplace 的镜像预检。
   * 逐个插件计算依赖闭包，返回因跨 marketplace 依赖而不能镜像的插件（票 08）。
   */
  inspectMarketplaceSourceMirror(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<PluginSyncMarketplaceMirrorInspection>;
  importMarketplaceSourceArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncMarketplaceSourceImportResult>;
  listLocalUserPluginCandidates(): Promise<PluginSyncCandidateListResult>;
  listRemoteUserPluginStatuses(params: {
    plugins: Array<{
      pluginId: string;
      directoryName: string;
    }>;
  }): Promise<PluginSyncRemoteStatusResult>;
  exportPluginsArchive(params: { pluginIds: string[] }): Promise<PluginSyncArchiveExportResult>;
  checkRemoteUserPluginWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importPluginsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncImportResult>;
}

export const IPluginSyncService = createServiceDescriptor<IPluginSyncService>(
  ServiceChannels.PluginSync,
);
