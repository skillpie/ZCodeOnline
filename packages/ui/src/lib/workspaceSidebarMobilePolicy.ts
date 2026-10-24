import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";

// 手机/平板等触摸设备（主输入为粗指针、无 hover）打开 Web 端时，左侧工作区侧栏默认收起：
// 竖屏窄宽度下侧栏固定宽度会占掉大半可视区，主会话几乎不可见。
// 这里只决定首屏初始值；收起后左上角 DesktopTopOverlay 仍保留展开入口，
// 用户手动展开/收起后的状态照常由 useAppPanels 的运行时状态接管，不做响应式强制切换。
export function resolveInitialWorkspaceSidebarVisible(): boolean {
  return !isCoarseTouchDevice();
}

// 侧边栏内「新建对话 / 进入会话」成功后是否自动收起侧栏的移动端策略：
// 仅触摸设备收起（竖屏宽度下进入会话后用户目标在主内容，侧栏继续展开只会遮挡）；
// 桌面端保持展开（分屏与键盘流依赖侧栏常驻）。导航未真正发生（只读 workspace、
// 远程目标未连接等 bail-out）时不收起，避免失败后丢失侧栏状态。
export function shouldCollapseSidebarAfterConversationActivate({
  proceeded,
  isCoarseTouch,
}: {
  proceeded: boolean;
  isCoarseTouch: boolean;
}): boolean {
  return proceeded && isCoarseTouch;
}

// H5 触摸设备（hover: none + pointer: coarse）在窄视口（<768px，与远控壳的移动断点同口径）
// 打开侧栏时，内联半屏布局会把会话区挤到右侧——既读不了也没有可点目标，任务标题反而被截断。
// 此时侧栏改为全屏覆盖展示；点击会话后收起复用上面的收起策略。
// iPad（≥768px）与桌面窄窗口（精确指针，点击会话不自动收起）不命中，保持原内联布局。
export const MOBILE_TOUCH_SIDEBAR_OVERLAY_QUERY =
  "(max-width: 767px) and (hover: none) and (pointer: coarse)";

// 远控壳（webRemoteControlWorkspaceSwitcher 存在）在 max-md 下把侧栏面板改造成顶部可折叠
// 导航，且有独立的移动任务首页；全屏覆盖会与其布局互相冲突，必须排除。
export function shouldApplyMobileTouchSidebarOverlay({
  matchesMobileTouchViewport,
  isWebRemoteControlShell,
}: {
  matchesMobileTouchViewport: boolean;
  isWebRemoteControlShell: boolean;
}): boolean {
  return matchesMobileTouchViewport && !isWebRemoteControlShell;
}
