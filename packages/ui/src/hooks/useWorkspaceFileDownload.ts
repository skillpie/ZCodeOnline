import { useCallback, useState } from "react";
import type { IFileService } from "@zcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  isWorkspaceFileTooLargeError,
  readWorkspaceFileBytes,
  saveBytesToLocal,
} from "@/lib/workspaceFileDownload.js";
import { toast } from "@/components/ui/toast.js";

/**
 * 工作区文件"下载到本地"的编排 hook——预览面板与消息文件链接共用的唯一入口。
 *
 * fileService 由调用方按各自既有的 workspace 作用域解析后传入
 * （预览面板走 useWorkspaceServices，文件链接走上下文 services），
 * 本 hook 只负责 stat → 分块读取 → saveFile/浏览器兜底 → toast 的事件顺序，
 * 因此在无 ServiceProvider 的只读渲染树里也可以安全使用（传 null 即不提供下载）。
 */
export function useWorkspaceFileDownload(options: { fileService: IFileService | null }) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadFile = useCallback(
    async (input: { path: string; suggestedName?: string }) => {
      const fileService = options.fileService;
      if (!fileService || isDownloading) {
        return;
      }
      const suggestedName =
        input.suggestedName?.trim() ||
        input.path.split(/[\\/]/).filter(Boolean).at(-1) ||
        input.path;
      setIsDownloading(true);
      try {
        const { bytes } = await readWorkspaceFileBytes({
          path: input.path,
          stat: (path) => fileService.stat({ path }),
          readRange: (offset, length) =>
            fileService.readFileRange({ path: input.path, offset, length }),
        });
        const outcome = await saveBytesToLocal({ platform, bytes, fileName: suggestedName });
        if (outcome.status === "canceled") {
          return;
        }
        if (outcome.status === "error") {
          throw new Error(outcome.error);
        }
        if (outcome.status === "saved" && outcome.path) {
          toast(
            intl.formatMessage({ id: "workspaceFile.downloadSucceeded" }, { path: outcome.path }),
          );
          return;
        }
        // saved 无 path（Web 平台实现）/浏览器兜底：浏览器没有完成回调，只能报告"已开始"。
        toast(intl.formatMessage({ id: "workspaceFile.downloadStarted" }));
      } catch (error) {
        logger.warn("[workspaceFileDownload] 下载失败", {
          path: input.path,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(
          intl.formatMessage({
            id: isWorkspaceFileTooLargeError(error)
              ? "workspaceFile.fileTooLarge"
              : "workspaceFile.downloadFailed",
          }),
        );
      } finally {
        setIsDownloading(false);
      }
    },
    [intl, isDownloading, options.fileService, platform],
  );

  return { downloadFile, isDownloading };
}
