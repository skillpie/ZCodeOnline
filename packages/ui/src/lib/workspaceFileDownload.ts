import { sanitizeSuggestedFileName } from "@zcode/shared";
import type { IPlatformService } from "@zcode/shared";

/**
 * 工作区文件"下载到本地"的纯规则层——预览面板与消息文件链接共用。
 *
 * 读取沿用 pptxPreviewData.ts 的分块习语（256KiB 一块、读完拼一个 Uint8Array），
 * 上限与桌面 saveFile 的 MAX_SAVE_FILE_BYTES 对齐（50MiB），两个入口拿同一份错误语义。
 * 保存优先走 `platform.saveFile`（桌面系统另存为框 / Web Blob 下载），
 * 平台未实现时退浏览器 anchor 下载兜底。
 */

export const WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const WORKSPACE_FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

export class WorkspaceFileTooLargeError extends Error {
  readonly code = "workspace_file_too_large";

  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Workspace file download exceeded the ${maxBytes} bytes limit: file has ${sizeBytes} bytes`,
    );
    this.name = "WorkspaceFileTooLargeError";
  }
}

export class WorkspaceFileReadError extends Error {
  constructor(
    readonly code:
      | "workspace_file_not_a_file"
      | "workspace_file_read_incomplete"
      | "workspace_file_range_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileReadError";
  }
}

export function isWorkspaceFileTooLargeError(error: unknown): error is WorkspaceFileTooLargeError {
  return (
    error instanceof WorkspaceFileTooLargeError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "workspace_file_too_large")
  );
}

/**
 * 点击直接下载的扩展名：数据交付类（csv/parquet/压缩包等）与常用办公文档
 * （xls/xlsx/doc/docx/ppt/pptx/pdf 等）——它们多数是 Agent 的交付物，"拿到文件"
 * 的价值高于"先看一眼"，所以消息里的文件链接点击时直接触发下载而不是打开预览；
 * 预览退路保留在右键菜单的"打开"。纯文本/网页类（md/html）仍走预览。
 */
const DOWNLOAD_ON_CLICK_EXTENSIONS: ReadonlySet<string> = new Set([
  // 数据交付
  ".csv",
  ".tsv",
  ".jsonl",
  ".ndjson",
  ".parquet",
  ".sqlite",
  ".db",
  // 压缩包
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".7z",
  ".rar",
  ".xz",
  // 办公文档
  ".xls",
  ".xlsx",
  ".xlsb",
  ".xlsm",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".pdf",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
]);

export function shouldDownloadDirectlyOnFileLinkClick(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) {
    return false;
  }
  return DOWNLOAD_ON_CLICK_EXTENSIONS.has(normalized.slice(dotIndex));
}

/** stat 的最小结构面（FileStat）；独立声明避免本模块依赖 services 包。 */
export interface WorkspaceFileDownloadStat {
  type: "file" | "directory";
  size?: number;
}

/**
 * 读取整个文件字节。size 已知时按定长分配、分块填入；size 缺失（旧远端 stat）时
 * 逐块累加、读到短块为止，超限在读取过程中即时截断，不等整文件进内存。
 */
export async function readWorkspaceFileBytes(input: {
  path: string;
  stat: (path: string) => Promise<WorkspaceFileDownloadStat>;
  readRange: (offset: number, length: number) => Promise<Uint8Array>;
  maxBytes?: number;
}): Promise<{ bytes: Uint8Array; sizeBytes: number }> {
  const maxBytes = input.maxBytes ?? WORKSPACE_FILE_DOWNLOAD_MAX_BYTES;
  const fileStat = await input.stat(input.path);
  if (fileStat.type !== "file") {
    throw new WorkspaceFileReadError(
      "workspace_file_not_a_file",
      `Workspace file download target is not a regular file: ${input.path}`,
    );
  }

  const readChunk = async (offset: number, requestedLength: number) => {
    const chunk = await input.readRange(offset, requestedLength);
    if (chunk.length === 0) {
      // readFileRange 在文件被并发截断/远端版本不一致时返回空 chunk；
      // 此时读游标已不可信，继续拼只会产出损坏字节。
      throw new WorkspaceFileReadError(
        "workspace_file_read_incomplete",
        `Workspace file read ended early at offset ${offset}: ${input.path}`,
      );
    }
    if (chunk.length > requestedLength) {
      throw new WorkspaceFileReadError(
        "workspace_file_range_exceeded",
        `Workspace file read exceeded request: requested ${requestedLength} bytes, received ${chunk.length}`,
      );
    }
    return chunk;
  };

  const fileSize = fileStat.size;
  if (typeof fileSize === "number") {
    if (fileSize > maxBytes) {
      throw new WorkspaceFileTooLargeError(fileSize, maxBytes);
    }
    const bytes = new Uint8Array(new ArrayBuffer(fileSize));
    let offset = 0;
    while (offset < fileSize) {
      const requestedLength = Math.min(WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES, fileSize - offset);
      const chunk = await readChunk(offset, requestedLength);
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { bytes, sizeBytes: fileSize };
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (let offset = 0; ; offset += WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES) {
    const chunk = await readChunk(offset, WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES);
    receivedBytes += chunk.length;
    if (receivedBytes > maxBytes) {
      throw new WorkspaceFileTooLargeError(receivedBytes, maxBytes);
    }
    chunks.push(chunk);
    if (chunk.length < WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES) {
      break;
    }
  }
  const bytes = new Uint8Array(new ArrayBuffer(receivedBytes));
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return { bytes, sizeBytes: receivedBytes };
}

export type WorkspaceFileSaveOutcome =
  | { status: "saved"; via: "platform"; path?: string }
  | { status: "started"; via: "browser" }
  | { status: "canceled" }
  | { status: "error"; error: string };

/** 视图需要时才把整份 Uint8Array 变回 ArrayBuffer（saveFile 的 data 形参要求）。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  // SharedArrayBuffer 不是合法的 structured clone 之外的 Blob/saveFile 载荷，拷贝一份规整类型。
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** Blob + `<a download>`：平台 saveFile 缺席时的兜底（Web 历史路径，见图片预览）。 */
function startBrowserBlobDownload(bytes: Uint8Array, fileName: string): void {
  const objectUrl = URL.createObjectURL(new Blob([toArrayBuffer(bytes)]));
  const link = document.createElement("a");
  try {
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function saveBytesToLocal(input: {
  platform: Pick<IPlatformService, "saveFile"> | null;
  bytes: Uint8Array;
  fileName: string;
}): Promise<WorkspaceFileSaveOutcome> {
  const fileName = sanitizeSuggestedFileName(input.fileName);
  if (!fileName) {
    return { status: "error", error: "invalid_file_payload" };
  }
  // 空文件在入口统一拒绝（桌面 handler 同规则），不管走平台还是浏览器兜底。
  if (input.bytes.length === 0) {
    return { status: "error", error: "invalid_file_payload" };
  }
  if (input.platform?.saveFile) {
    const result = await input.platform.saveFile({
      data: toArrayBuffer(input.bytes),
      suggestedName: fileName,
    });
    if (result.canceled) {
      return { status: "canceled" };
    }
    if (!result.success) {
      return { status: "error", error: result.error ?? "save_failed" };
    }
    return { status: "saved", via: "platform", ...(result.path ? { path: result.path } : {}) };
  }
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return { status: "error", error: "not_supported" };
  }
  startBrowserBlobDownload(input.bytes, fileName);
  return { status: "started", via: "browser" };
}
