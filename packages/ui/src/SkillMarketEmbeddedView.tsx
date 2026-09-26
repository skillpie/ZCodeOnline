// 技能市场主区内嵌视图：skillpie.cn 以工作区主视图形态呈现，侧边栏保持可见。
// 按产品规则不提供关闭/前进/后退工具栏，离开视图靠侧边栏入口切换。
// 平台差异：桌面端用 Electron <webview>（持久分区保留登录态、可感知加载失败）；
// Web 端用 <iframe>（skillpie.cn 未下发 X-Frame-Options/CSP frame-ancestors，可直接嵌入；
// 跨源限制拿不到子页导航态与失败信号，不做错误兜底 UI）。
//
// 免登握手：ZCode 登录用户打开技能市场时，向 skillpie 页面提供平台 JWT，
// 由 skillpie 服务端验证后自动注册/登录（协议见 specs/skill-market.md）。
// iframe 走 window postMessage；<webview> 的 guest 与宿主是独立 frame 树，
// 走 ipc-message（skillpie:sso-request）/ webview.send（zcode:sso-response），
// 由 skillMarketWebview preload 在 guest 侧转投页面。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { resolveJwtExpiration } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { SKILL_MARKET_URL } from "@/lib/skillMarketUrl.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const SKILL_MARKET_ORIGIN = new URL(SKILL_MARKET_URL).origin;
const SSO_REQUEST_TYPE = "skillpie:sso-request";
const SSO_RESPONSE_TYPE = "zcode:sso-response";

interface SkillMarketEmbeddedViewProps {
  /** 是否为 Electron 桌面端：决定渲染 <webview>（桌面）还是 <iframe>（Web）。 */
  isDesktop: boolean;
  /**
   * 初始路径（如 /skills?skill=<normalizedName>）：从付费技能详情弹窗「前往技能市场」
   * 深链到技能详情页；undefined = 市场首页。内嵌元素随视图切换卸载/重挂，
   * 挂载时读一次即可。
   */
  initialPath?: string;
  /**
   * 读取 zcode 平台 JWT：桌面端由宿主凭据库（zcodejwttoken）提供，
   * Web 端由入口注入（浏览器 localStorage）。返回 null 表示当前未登录，
   * 握手会回空 JWT，skillpie 页面降级为自身登录。
   */
  loadSsoJwtToken?: () => Promise<string | null>;
}

export function SkillMarketEmbeddedView({
  isDesktop,
  initialPath,
  loadSsoJwtToken,
}: SkillMarketEmbeddedViewProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const user = useZCodeStoreWithDefault((state) => state.user ?? null, null);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const webviewCleanupRef = useRef<(() => void) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initialSrc = useMemo(
    () => (initialPath ? new URL(initialPath, SKILL_MARKET_URL).toString() : SKILL_MARKET_URL),
    [initialPath],
  );

  // 桌面 webview 加载失败后的兜底：交给系统浏览器打开同一地址。
  const handleOpenWebsite = useCallback(() => {
    platform.openExternal(SKILL_MARKET_URL);
  }, [platform]);

  // 组装握手响应。JWT 每次握手时现读，保证轮换后的 token 不滞后；
  // profile 仅作展示字段，身份绑定以 JWT sub 为准（服务端在线验证）。
  const buildSsoResponse = useCallback(async () => {
    let jwt: string | null = null;
    if (loadSsoJwtToken) {
      try {
        jwt = (await loadSsoJwtToken())?.trim() || null;
      } catch (error) {
        logger.warn("[SkillMarketEmbeddedView] 读取 SSO 凭据失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // UI 登录展示态与 token 有效期是解耦的（过期仍显示已登录）；
    // 过期 JWT 提前回空，避免 skillpie 侧无意义的 401 往返。
    if (jwt && resolveJwtExpiration(jwt).kind === "expired") {
      logger.info("[SkillMarketEmbeddedView] SSO 凭据已过期，回空 JWT（请重新登录 ZCode）");
      jwt = null;
    }
    // 免登链路的静默失败（未登录/凭据过期）只能靠这条日志定位，jwt 不落日志只报有无。
    logger.info("[SkillMarketEmbeddedView] SSO 握手应答", { hasJwt: Boolean(jwt) });
    return {
      type: SSO_RESPONSE_TYPE,
      jwt,
      profile: user?.displayName ? { displayName: user.displayName } : {},
    };
  }, [loadSsoJwtToken, user]);

  // iframe 场景：skillpie 桥接组件向 parent 发握手请求，这里按目标 origin 严格回包。
  useEffect(() => {
    if (isDesktop) {
      return;
    }
    let cancelled = false;
    const handleMessage = (event: MessageEvent) => {
      if (cancelled || event.origin !== SKILL_MARKET_ORIGIN) {
        return;
      }
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== SSO_REQUEST_TYPE) {
        return;
      }
      const source = event.source as Window | null;
      void buildSsoResponse().then((payload) => {
        if (!cancelled && source) {
          source.postMessage(payload, { targetOrigin: SKILL_MARKET_ORIGIN });
        }
      });
    };
    window.addEventListener("message", handleMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", handleMessage);
    };
  }, [buildSsoResponse, isDesktop]);

  const handleWebviewRef = useCallback(
    (element: ElectronWebviewTag | null) => {
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
        logger.warn("[SkillMarketEmbeddedView] webview 加载失败", {
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL,
        });
        setLoadError(event.errorDescription || String(event.errorCode));
      };
      const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
        logger.warn("[SkillMarketEmbeddedView] webview 渲染进程崩溃", {
          reason: event.details.reason,
          exitCode: event.details.exitCode,
        });
        setLoadError(event.details.reason);
      };
      // 免登握手：preload 在 guest 加载后发 skillpie:sso-request，这里回传身份。
      const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
        if (event.channel !== SSO_REQUEST_TYPE) {
          return;
        }
        void buildSsoResponse().then((payload) => {
          try {
            webviewRef.current?.send(SSO_RESPONSE_TYPE, payload);
          } catch (error) {
            // webview 已销毁时 send 会抛；页面重新导航会再次握手。
            logger.debug("[SkillMarketEmbeddedView] 回传 SSO 响应失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      };
      // skillpie 的安装/分享要写入剪贴板；webview 的权限请求未处理默认会被拒。
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
      element.addEventListener("ipc-message", handleIpcMessage);
      element.addEventListener("permissionrequest", handlePermissionRequest);
      webviewCleanupRef.current = () => {
        element.removeEventListener("did-start-loading", handleDidStartLoading);
        element.removeEventListener("did-fail-load", handleDidFailLoad);
        element.removeEventListener("render-process-gone", handleRenderProcessGone);
        element.removeEventListener("ipc-message", handleIpcMessage);
        element.removeEventListener("permissionrequest", handlePermissionRequest);
      };
    },
    [buildSsoResponse],
  );

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
          data-testid="skill-market-embedded-load-error"
        >
          <span className="font-medium text-foreground">
            {intl.formatMessage({ id: "skillMarket.embedded.loadFailed" })}
          </span>
          <span className="break-all text-ui-sm text-foreground-subtle">{loadError}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleOpenWebsite}>
              <ExternalLinkIcon className="size-3.5" />
              {intl.formatMessage({ id: "skillMarket.embedded.openWebsite" })}
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
          partition="persist:zcode-skill-market"
          src={initialSrc}
          className={cn("min-h-0 flex-1 bg-background", loadError && "hidden")}
          data-testid="skill-market-embedded-webview"
        />
      ) : (
        <iframe
          src={initialSrc}
          title={intl.formatMessage({ id: "workspace.openSkillMarket" })}
          // skillpie 的安装/分享依赖写入剪贴板；跨源 iframe 需宿主通过
          // Permissions Policy 显式委托 clipboard-write，否则 navigator.clipboard 被拦。
          allow="clipboard-write"
          className="min-h-0 flex-1 border-0 bg-background"
          data-testid="skill-market-embedded-iframe"
        />
      )}
    </div>
  );
}
