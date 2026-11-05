import type {
  RemoteSyncWriteAccessResult,
  SkillDataSyncPayload,
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";

/**
 * 技能同步服务：官方 DataSync* 通道（IDataSyncCategoryService，docs/remote/data-sync.md）
 * 之上附加 fork 旧路径 RemoteSkillSyncDialog 的方法（listLocalUserSkillCandidates 等）：
 * 归档式「只新增、同名跳过」语义与展示字段依赖它们；两套方法由同一实现提供。
 */
export interface ISkillSyncService extends IDataSyncCategoryService<SkillDataSyncPayload> {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
}

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
