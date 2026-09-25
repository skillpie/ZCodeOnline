// 控制客户端公开入口（specs/web-tunnel.md §5.5 路线 B）：
// 供桌面 App 管理面经控制 socket 访问 server-cli daemon（隧道状态/启用/配对）。
// 只导出客户端面；Supervisor/Core 的实现细节不经此出口外泄。
export { ControlRequestError } from "./ipc/controlError.js";
export { requestControl } from "./ipc/controlClient.js";
export { resolveServerLayout, type ServerLayout } from "./runtime/paths.js";
export type { ServerStatus } from "./contracts.js";
