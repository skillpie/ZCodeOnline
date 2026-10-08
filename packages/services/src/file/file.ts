import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number;
  /** 无命中补扫：绕过尚未过期的文件索引。 */
  refresh?: boolean;
}

export interface WorkspaceContentSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  /** 全局匹配上限，缺省 100，clamp [1, 100]。 */
  limit?: number;
}

export interface WorkspaceContentSearchMatch {
  path: string;
  relativePath: string;
  name: string;
  /** 1-based 行号。 */
  line: number;
  /** 匹配行 trim 后内容（≤240 字符）。 */
  text: string;
}

export interface IFileService {
  /** Host 匹配并返回有界候选，避免 Renderer 下载完整文件索引。 */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  /**
   * 内容搜索（命令中心「内容」范围）：Host 有界扫描 workspace 文本文件。
   * 与 searchWorkspaceFiles 共用同一份 .zcodeignore 索引；扫描边界见
   * specs/command-center.md §3。无状态、无取消通道，成本靠扫描边界兜底。
   */
  searchWorkspaceContent(
    params: WorkspaceContentSearchParams,
  ): Promise<WorkspaceContentSearchMatch[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  /**
   * 以 UTF-8 覆写已有文本文件（预览面板编辑保存路径）。
   * 只允许覆写已存在的常规文件，不创建新文件、不建目录；
   * 内容超过 MAX_TEXT_WRITE_BYTES 时抛错，防止把大文本误写进 Host。
   */
  writeTextFile(params: { path: string; content: string }): Promise<void>;
  /**
   * 重命名同一目录下的文件或目录（文件树右键「重命名」）。
   * nextName 只允许单段名称（拒绝 `/`、`\`、`.`、`..` 与空白名），
   * 目标已存在时抛错——POSIX rename 会静默覆盖同名文件，必须在服务端挡住。
   */
  renameEntry(params: { path: string; nextName: string }): Promise<void>;
  /**
   * 删除文件或目录（文件树右键「删除」，UI 侧已做二次确认）。
   * 目录递归删除且不可恢复；拒绝空路径与文件系统根，避免把整棵根目录交给 rm。
   */
  deleteEntry(params: { path: string }): Promise<void>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * 按偏移读取文件的一段原始字节，供大二进制文件（如 PDF）按需分段加载。
   * 返回值必须保持顶层 Uint8Array：RPC 序列化只对顶层二进制走原始字节通道，
   * 嵌套在对象字段里会退化成 JSON+base64。EOF 时返回短数组。
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * workspace 文件索引的列式打包长度（字符数）。与 listWorkspaceFilesRange 配对，
   * 调用方按长度分块拉取（见 fetchWorkspaceFileEntriesPacked）。
   * 返回 number：RPC Int 快速路径。
   */
  listWorkspaceFilesLength(params: { rootPath: string }): Promise<number>;
  /**
   * 分块返回列式打包字符串（workspaceFileEntriesCodec 格式，[offset, offset+length)）。
   * 必须是裸 string 顶层返回：RPC String 快速路径（长度前缀+原始字节）；Object 会
   * JSON 转义大字符串（实测 6-9s 主线程长任务）。单块不超过 ~4MB：大消息在
   * renderer 接收端的分帧重组是秒级长任务（实测 4.6-6.3s），分块 + 块间让出后
   * 主线程每次只处理一小块（~50ms），输入永不冻结。
   * Host 侧有 60s TTL + .zcodeignore 指纹签名的整包缓存，分块只是切片。
   */
  listWorkspaceFilesRange(params: {
    rootPath: string;
    offset: number;
    length: number;
  }): Promise<string>;
  /**
   * workspace 搜索忽略规则（.zcodeignore）的读写，供设置页编辑使用。
   * source: "file" 已存在文件内容；"template" 尚未创建时的初始内容预览（保存时才落盘）。
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
   * "sync-gitignore" 只重写 gitignore 同步区（保留默认段与自定义区）；
   * "reset-defaults" 只重置默认排除段（保留 gitignore 区与自定义区）。
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: { rootPath: string; content: string }): Promise<void>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);
