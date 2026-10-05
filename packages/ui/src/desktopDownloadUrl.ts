// Web 端「下载桌面版」安装包直链。安装包由人工上传到站点 /var/www/zcode-dl/desktop/
// （nginx `location ^~ /dl/` 直出），不用官方 zcode.z.ai CDN 包。
// 文件名固定不带版本号：发版时同名覆盖即可，前端链接长期不变。
import { relayWebOrigin, DEFAULT_TUNNEL_RELAY_URL } from "@zcode/shared";

export type DesktopDownloadPlatform = "mac" | "windows";

/** 站点上约定的安装包路径；对应 electron-builder 产物改名后上传（mac=dmg, win=nsis exe）。 */
export const DESKTOP_DOWNLOAD_PATHS: Record<DesktopDownloadPlatform, string> = {
  mac: "/dl/desktop/ZCode-latest-mac-arm64.dmg",
  windows: "/dl/desktop/ZCode-latest-win-x64.exe",
};

/** 解析安装包直链；origin 传站点基址（Web 部署即 window.location.origin）。 */
export function resolveDesktopDownloadUrl(
  platform: DesktopDownloadPlatform,
  origin: string,
): string {
  return `${origin.replace(/\/+$/u, "")}${DESKTOP_DOWNLOAD_PATHS[platform]}`;
}

/** 兜底站点基址：window.location 不可用时（SSR/测试）退回隧道默认站点。 */
export function resolveDefaultDesktopDownloadSiteOrigin(): string {
  return relayWebOrigin(DEFAULT_TUNNEL_RELAY_URL);
}

/**
 * 按访客 UA 推测当前桌面系统，用于弹窗内「推荐」高亮。
 * 手机与识别失败的 UA 返回 null，不做推荐。
 */
export function detectDesktopDownloadPlatform(userAgent: string): DesktopDownloadPlatform | null {
  // iOS UA 携带 "like Mac OS X"，先排除移动设备再判桌面系统。
  if (/iPhone|iPod|Android|Mobile/i.test(userAgent)) {
    return null;
  }
  if (/Windows/i.test(userAgent)) {
    return "windows";
  }
  // iPad 以桌面 UA 访问时也含 Macintosh，按 Mac 推荐可接受（下载 dmg 在 iPad 上无意义但无害）。
  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return "mac";
  }
  return null;
}
