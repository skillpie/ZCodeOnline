// 附件命令面：AttachmentRef（引用模型）→ core TurnAttachment 的协议边界映射。
//
// ref 的两种形态（与投影侧 buildUserInputRow 的「本地路径 / artifact URI」注释对偶）：
// 1. URI ref（zcode-artifact:// 等带 scheme:/）——经 attachment chunk transaction 寄存的内容引用：
//    - 图片/视频：content 直接携带 URI，core 的 attachment-artifacts 解析链在模型请求时
//      读回 data URL（与 externalizePromptAttachments 的产物同形，不在这里内联解码，
//      避免大媒体在命令层放大内存）。
//    - PDF：保留 URI 交给 core 的 PDF resolver；其他非图片：文本类小文件按旧
//      decodeTextProtocolAttachment 语义解成 ≤64KiB 文本；其余（含全部二进制）物化
//      artifact 为本地文件按 path 引用交付——旧实现把二进制按 UTF-8 解码成乱码、
//      超限后只剩元信息，模型永远读不到内容（Web 端 xlsx 附件不可用的第二层根因）。
// 2. 本地路径 ref（desktop 直传绝对路径）——按旧 mapProtocolPromptAttachment 的
//    localPath 分支映射为 path 引用，core 已有读取阈值与降级策略。
import type { TurnAttachment } from "@zcode/core";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";

const URI_REF_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export function isUriAttachmentRef(ref: string): boolean {
  return URI_REF_PATTERN.test(ref);
}

function displayMetaOf(
  ref: AttachmentRef,
): Pick<TurnAttachment, "filename" | "mimeType" | "sizeBytes" | "sourceKind" | "messageCount"> {
  return {
    filename: ref.fileName,
    mimeType: ref.mime,
    sizeBytes: ref.bytes,
    ...(ref.sourceKind ? { sourceKind: ref.sourceKind, messageCount: ref.messageCount } : {}),
  };
}

function isImageRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

function isVideoRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("video/") ?? false;
}

function isPdfRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

/** 与 core isTextLikePath / renderer isTextLikeAttachment 同一张文本扩展名表。 */
const TEXT_LIKE_FILENAME_PATTERN =
  /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu;

function isTextLikeRef(ref: AttachmentRef): boolean {
  const mime = ref.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/") || TEXT_LIKE_FILENAME_PATTERN.test(ref.fileName);
}

/** data URL（data:<mime>;base64,<payload>）→ utf8 文本；非 base64 data URL 原样返回正文。 */
function decodeDataUrlText(content: string): string | undefined {
  if (!content.startsWith("data:")) return content;
  const commaIndex = content.indexOf(",");
  if (commaIndex === -1) return undefined;
  const header = content.slice(0, commaIndex);
  const payload = content.slice(commaIndex + 1);
  if (!header.includes(";base64")) return decodeURIComponent(payload);
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

async function mapAttachmentRef(app: ZCodeApp, ref: AttachmentRef): Promise<TurnAttachment> {
  const displayMeta = displayMetaOf(ref);
  if (!isUriAttachmentRef(ref.ref)) {
    // 本地路径引用：交给 core 的文件/图片读取链路（阈值与降级已内建）。
    if (isVideoRef(ref)) {
      return { path: ref.ref, type: "video", ...displayMeta };
    }
    return {
      path: ref.ref,
      type: isImageRef(ref) ? "image" : isPdfRef(ref) ? "pdf" : "file",
      ...displayMeta,
    };
  }
  if (ref.sourceKind === "topic-history" || ref.sourceKind === "clipboard-text") {
    // 文本材料必须保留 durable 引用；按普通小文件解码会重新隐藏注入整份历史。
    return { content: ref.ref, type: "file", ...displayMeta };
  }
  if (isImageRef(ref)) {
    // 图片 URI ref：content 携带 artifact URI，模型请求阶段由 resolveAttachmentDataUrl
    // 读回（与 externalizePromptAttachments 产物同形，天然免二次外置）。
    return { content: ref.ref, path: ref.fileName, type: "image", ...displayMeta };
  }
  if (isVideoRef(ref)) {
    // video URI ref：与图片同构——content 携带 artifact URI，模型请求阶段读回 data URL。
    return { content: ref.ref, path: ref.fileName, type: "video", ...displayMeta };
  }
  if (isPdfRef(ref)) {
    // PDF URI ref 必须保留 durable URI，交给 core 读取 data URL；不能按 UTF-8 文本解码。
    return { content: ref.ref, path: ref.fileName, type: "pdf", ...displayMeta };
  }
  // 文本类小文件：按旧 decodeTextProtocolAttachment 语义解成 ≤64KiB 文本内联，
  // 省一次落盘；二进制即使 ≤64KiB 也不走这里（UTF-8 解码只会产出乱码）。
  if (ref.bytes <= INLINE_TEXT_ATTACHMENT_MAX_BYTES && isTextLikeRef(ref)) {
    try {
      const artifact = await app.readToolResultArtifact(ref.ref);
      const text = decodeDataUrlText(artifact.content);
      return text !== undefined
        ? { content: text, path: ref.fileName, type: "file", ...displayMeta }
        : { type: "file", ...displayMeta };
    } catch {
      // 引用失效（TTL 回收/写失败）：保留展示元信息，不让整次发送失败。
      return { type: "file", ...displayMeta };
    }
  }
  // 其余（全部二进制 + 超长文本）：物化 artifact 为本地文件按 path 引用交付，
  // 与桌面 localPath 同构——core 的 resolveLocalFileAttachment 已有
  // 二进制→路径引用（binary_file）、文本→截断预览的降级链，模型按需用文件工具读取。
  try {
    const materialized = await app.materializePromptAttachmentPath?.({
      uri: ref.ref,
      fileName: ref.fileName,
    });
    if (materialized?.path) {
      return { path: materialized.path, type: "file", ...displayMeta };
    }
  } catch {
    // 物化失败不阻断发送：保留展示元信息（与旧超限降级同语义）。
  }
  return { type: "file", ...displayMeta };
}

/**
 * sendText/createSession/editUserQuery 共用：attachments 引用数组 → core TurnAttachment[]。
 * 空数组/缺省 → undefined（sendInput 语义：无附件不带字段）。
 */
export async function mapAttachmentRefsToTurnAttachments(
  app: ZCodeApp,
  refs: readonly AttachmentRef[] | undefined,
): Promise<TurnAttachment[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  const mapped = await Promise.all(refs.map((ref) => mapAttachmentRef(app, ref)));
  return mapped.length > 0 ? mapped : undefined;
}
