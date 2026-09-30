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
