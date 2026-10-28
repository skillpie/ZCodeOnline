// ============================================================
// Tool Artifact Store Port - large tool result storage boundary
// ============================================================

import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export type ToolArtifactRetention = "session" | "project" | "temporary";

export interface ToolArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: string;
  contentType?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

export interface ToolBinaryArtifactWriteRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  toolCallId: ToolCallId | string;
  toolName: string;
  content: Uint8Array;
  contentType: string;
  extension?: string;
  retention?: ToolArtifactRetention;
  trace?: TraceContext;
}

export interface ToolArtifactWriteResult {
  id: string;
  uri: string;
  path?: string;
  bytes: number;
  contentType: string;
  createdAt: Date;
}

export interface ToolArtifactReadRequest {
  uri: string;
  trace?: TraceContext;
}

export interface ToolArtifactReadResult {
  uri: string;
  content: string;
  contentType: string;
  bytes: number;
  path?: string;
}

/**
 * 二进制读回：**原始字节**，不经任何文本 / base64 编码。
 *
 * {@link ToolArtifactStorePort.readToolResultArtifact}
 * 把「按文件名再推一次 contentType → 文本走 utf8、其余走 base64」当作写入编码的逆运算，而
 * 推断表只认 txt/md/png/jpg/gif/webp/pdf/bin，`.xlsx` / `.docx` / `.pptx` 落到默认的
 * `application/json` 被当作 utf8 解码——办公文件读回即损坏且不可恢复。字节的消费者
 * （v4 分块查询、查看器）需要的是字节本身，编码是给模型面文本用的；两件事分开两个方法。
 * `contentType` 仍按文件名推断，仅供缺少更好来源的调用方兜底（dwf 用 journal 记录的那份）。
 */
export interface ToolBinaryArtifactReadResult {
  uri: string;
  bytes: Uint8Array;
  contentType: string;
  path?: string;
}

export interface ToolArtifactStatRequest {
  uri: string;
  trace?: TraceContext;
}

export interface ToolArtifactStatResult {
  uri: string;
  bytes: number;
  contentType: string;
  path?: string;
  mtimeMs?: number;
}

export interface ImageAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface MediaAttachmentPathPrimeRequest {
  uri: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface MediaAttachmentPathEnsureRequest {
  uri: string;
  mediaType: string;
}

export interface PromptAttachmentPathEnsureRequest {
  uri: string;
  /** 原始文件名：派生文件保留扩展名，供下游工具/技能按类型识别。 */
  fileName: string;
}

export type MediaAttachmentPathResult =
  | { status: "ready"; path: string }
  | { status: "unsupported" };

export interface ToolArtifactStorePort {
  writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  writeToolResultBinaryArtifact?(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult>;
  readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult>;
  /**
   * 原始字节读回（见 {@link ToolBinaryArtifactReadResult}）。可选：与
   * {@link writeToolResultBinaryArtifact} 同规，不带二进制能力的 store 实现不必陪跑；
   * 消费方 `typeof` 探测，缺席即「本 store 不能提供字节」——不得退回文本读再解码。
   */
  readToolResultBinaryArtifact?(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult>;
  statToolResultArtifact?(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult>;
  primeImageAttachmentPath?(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  primeMediaAttachmentPath?(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult>;
  ensureMediaAttachmentPath?(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult>;
  /**
   * 把 prompt 附件 artifact（data-URL 形态）物化为可被文件工具读取的本地路径。
   * 与 {@link ensureMediaAttachmentPath} 同规：派生文件是可重建缓存，确定性路径按
   * uri+fileName 幂等；可选能力，缺席/unsupported 时消费方降级为仅展示元信息。
   */
  ensurePromptAttachmentPath?(
    request: PromptAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult>;
}
