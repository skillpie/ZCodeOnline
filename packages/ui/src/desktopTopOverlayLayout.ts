/**
 * DesktopTopOverlay 折叠按钮变体裁决。
 *
 * 背景（bugfix）：折叠按钮此前只按 `isMacDesktop` / `usesCustomCaptionArea`
 * （Windows/Linux 自绘标题栏）渲染，Web 入口不传这些平台标志，导致 Web
 * 左上角只剩前进/后退箭头，侧栏收起后没有任何可见的展开入口。
 * 现统一为：有自绘标题栏的平台用 Logo hover 变体，其余（macOS 与 Web）
 * 一律渲染普通图标按钮，保证所有环境都有折叠入口。
 */
export type SidebarToggleVariant = "logoHover" | "plain";

export function resolveSidebarToggleVariant(input: {
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
}): SidebarToggleVariant {
  if (input.isWindowsDesktop || input.isLinuxDesktop) {
    return "logoHover";
  }
  return "plain";
}
