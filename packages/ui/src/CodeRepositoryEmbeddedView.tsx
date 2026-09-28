// 代码仓库主区内嵌视图：设置页通用区「代码仓库设置」配置的地址以工作区主视图形态
// 呈现，侧边栏保持可见；离开视图靠侧边栏切换（specs/skill-market.md §1 同款交互）。
// 平台差异：桌面端用 Electron <webview>（独立持久分区保留仓库登录态、可感知加载失败；
// 命中 skillpie origin 才注入 SSO preload，其余走内置浏览器 Dialog 桥，见
// desktopWindowChrome.ts will-attach-webview）；Web 端用 <iframe>（跨源拿不到子页
// 导航态与失败信号，GitHub 等下发 X-Frame-Options 的站点无法内嵌，不做错误兜底 UI）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const CODE_REPOSITORY_PARTITION = "persist:zcode-code-repository";

interface CodeRepositoryEmbeddedViewProps {
  /** 要内嵌的仓库地址（设置页已归一化的 http(s) 完整链接）。 */
  url: string;
  /** 是否为 Electron 桌面端：决定渲染 <webview>（桌面）还是 <iframe>（Web）。 */
  isDesktop: boolean;
}

export function CodeRepositoryEmbeddedView({ url, isDesktop }: CodeRepositoryEmbeddedViewProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const webviewCleanupRef = useRef<(() => void) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 桌面 webview 加载失败后的兜底：交给系统浏览器打开同一地址。
  const handleOpenWebsite = useCallback(() => {
    platform.openExternal(url);
  }, [platform, url]);

  const handleWebviewRef = useCallback((element: ElectronWebviewTag | null) => {
    webviewCleanupRef.current?.();
    webviewCleanupRef.current = null;
    webviewRef.current = element;
    if (!element) {
      return;
    }
    const handleDidStartLoading = () => {
      setLoadError(null);
    };
    // did-fail-load 只对主 frame 报错，避免单个子资源失败把整页打成错误态。
    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      if (!event.isMainFrame) {
        return;
      }
      logger.warn("[CodeRepositoryEmbeddedView] webview 加载失败", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        validatedURL: event.validatedURL,
      });
      setLoadError(event.errorDescription || String(event.errorCode));
    };
    const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
      logger.warn("[CodeRepositoryEmbeddedView] webview 渲染进程崩溃", {
        reason: event.details.reason,
        exitCode: event.details.exitCode,
      });
      setLoadError(event.details.reason);
    };
    // 仓库站点的复制克隆地址等操作依赖剪贴板；webview 的权限请求未处理默认会被拒。
    const handlePermissionRequest = (event: ElectronWebviewPermissionRequestEvent) => {
      if (
        event.permission === "clipboard-sanitize-write" ||
        event.permission === "clipboard-read"
      ) {
        event.request.approve();
      }
    };

    element.addEventListener("did-start-loading", handleDidStartLoading);
    element.addEventListener("did-fail-load", handleDidFailLoad);
    element.addEventListener("render-process-gone", handleRenderProcessGone);
    element.addEventListener("permissionrequest", handlePermissionRequest);
    webviewCleanupRef.current = () => {
      element.removeEventListener("did-start-loading", handleDidStartLoading);
      element.removeEventListener("did-fail-load", handleDidFailLoad);
      element.removeEventListener("render-process-gone", handleRenderProcessGone);
      element.removeEventListener("permissionrequest", handlePermissionRequest);
    };
  }, []);

  useEffect(() => {
    return () => {
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {loadError ? (
        <div
          className="mx-auto mt-6 flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
          data-testid="code-repository-embedded-load-error"
        >
          <span className="font-medium text-foreground">
            {intl.formatMessage({ id: "codeRepository.embedded.loadFailed" })}
          </span>
          <span className="break-all text-ui-sm text-foreground-subtle">{loadError}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleOpenWebsite}>
              <ExternalLinkIcon className="size-3.5" />
              {intl.formatMessage({ id: "codeRepository.embedded.openWebsite" })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => webviewRef.current?.reload()}>
              <RefreshCwIcon className="size-3.5" />
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          </div>
        </div>
      ) : null}
      {isDesktop ? (
        <webview
          ref={handleWebviewRef}
          allowpopups={"" as unknown as boolean}
          partition={CODE_REPOSITORY_PARTITION}
          src={url}
          className={cn("min-h-0 flex-1 bg-background", loadError && "hidden")}
          data-testid="code-repository-embedded-webview"
        />
      ) : (
        <iframe
          src={url}
          title={intl.formatMessage({ id: "workspace.openCodeRepository" })}
          // 仓库站点的复制克隆地址依赖剪贴板；跨源 iframe 需宿主通过
          // Permissions Policy 显式委托 clipboard-write，否则 navigator.clipboard 被拦。
          allow="clipboard-write"
          className="min-h-0 flex-1 border-0 bg-background"
          data-testid="code-repository-embedded-iframe"
        />
      )}
    </div>
  );
}
