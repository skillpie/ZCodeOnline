import {
  sanitizeSuggestedFileName,
  type SaveFileRequest,
  type SaveFileResult,
} from "@zcode/shared";

/**
 * Web 端的 IPlatformService.saveFile 实现：浏览器下载。
 *
 * 与桌面 desktopSaveFile.ts 保持同一套入口校验（清洗后非空、payload 形状、空字节拒绝），
 * 差异只在写入方式：data 走 Blob + `<a download>`；sourceUrl 交给浏览器导航
 * （与图片预览的 startBrowserNativeDownload 同语义——跨域资源浏览器可自行决定下载或打开）。
 * 浏览器没有"保存完成"回调，success 且不带 path 即"已开始下载"。
 */
export function createWebSaveFile(): (payload: SaveFileRequest) => Promise<SaveFileResult> {
  return async (payload) => {
    if (!payload || typeof payload.suggestedName !== "string") {
      return { success: false, error: "invalid_file_payload" };
    }
    const suggestedName = sanitizeSuggestedFileName(payload.suggestedName);
    const data = payload.data instanceof ArrayBuffer ? payload.data : null;
    const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl : null;
    if (!suggestedName || (data === null && sourceUrl === null)) {
      return { success: false, error: "invalid_file_payload" };
    }
    if (data !== null && data.byteLength === 0) {
      return { success: false, error: "invalid_file_payload" };
    }
    if (
      typeof document === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return { success: false, error: "not_supported" };
    }

    const link = document.createElement("a");
    let objectUrl: string | null = null;
    try {
      if (data !== null) {
        objectUrl = URL.createObjectURL(new Blob([data]));
        link.href = objectUrl;
        link.download = suggestedName;
      } else if (sourceUrl !== null) {
        link.href = sourceUrl;
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        link.download = suggestedName;
      } else {
        return { success: false, error: "invalid_file_payload" };
      }
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    }
    return { success: true };
  };
}
