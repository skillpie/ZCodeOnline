import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";

// 手机/平板等触摸设备（主输入为粗指针、无 hover）打开 Web 端时，左侧工作区侧栏默认收起：
// 竖屏窄宽度下侧栏固定宽度会占掉大半可视区，主会话几乎不可见。
// 这里只决定首屏初始值；收起后左上角 DesktopTopOverlay 仍保留展开入口，
// 用户手动展开/收起后的状态照常由 useAppPanels 的运行时状态接管，不做响应式强制切换。
export function resolveInitialWorkspaceSidebarVisible(): boolean {
  return !isCoarseTouchDevice();
}
