import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpDataSyncPayload,
  McpSyncCandidateListResult,
  McpSyncExportResult,
  McpSyncImportResult,
  McpSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
  SaveCliMcpToUserDirectoryRequest,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpListResult,
  WorkspaceMcpTrustDecision,
  ZCodeWorkspaceMcpTrustResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * MCP 通道：设置页配置读写 + 数据同步（IDataSyncCategoryService，docs/remote/data-sync.md「MCP 服务器」）。
 * fork 附加方法（listLocalUserMcpCandidates 等）服务旧路径 RemoteMcpSyncDialog：
 * 归档式「只新增、同名跳过」语义与展示字段（config/source/path）依赖它们；
 * 官方 DataSync* 通道方法保持原样，两套方法由同一实现提供。
 */
export interface IMcpSyncService extends IDataSyncCategoryService<McpDataSyncPayload> {
  loadMcpFromUserDirectory(
    request?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  /**
   * workspace MCP server 运行态状态列表（原 UI 直调 zcodeAgentService 的
   * mcp/list）。真实 connect/listTools 检查必须发生在 agent 进程（PATH/cwd 是
   * workspace 环境），本服务只是 UI 的注入面——mcp/list 词的 host 消费收拢到实现一处。
   */
  listWorkspaceMcpServerStatuses(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    mode?: ZCodeMcpListMode;
  }): Promise<ZCodeMcpListResult>;
  setWorkspaceMcpTrust?(params: WorkspaceMcpTrustDecision): Promise<ZCodeWorkspaceMcpTrustResult>;
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
  listLocalUserMcpCandidates(): Promise<McpSyncCandidateListResult>;
  listRemoteUserMcpStatuses(params: { names: string[] }): Promise<McpSyncRemoteStatusResult>;
  exportMcpServers(params: { serverIds: string[] }): Promise<McpSyncExportResult>;
  checkRemoteUserMcpWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMcpServers(params: {
    servers: McpSyncExportResult["servers"];
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteWorkspacePath?: string;
    overwrite?: false;
  }): Promise<McpSyncImportResult>;
}

export const IMcpSyncService = createServiceDescriptor<IMcpSyncService>(ServiceChannels.McpSync);
