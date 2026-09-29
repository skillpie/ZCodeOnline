// 隧道连接失败的可重试判定（specs/web-tunnel.md §3.5 退避语义）：
// - network / hostOffline：relay 重启空窗或宿主尚未重新注册，退避重试即可恢复；
// - invalidSessionCredential / connectTokenInvalid：relay 的会话与票据在内存，
//   重启即失效——清掉旧凭证重跑连接链自愈；
// - 协议类失败（版本不匹配、端到端握手失败）不重试：会话与 PSK 仍有效，手动处理。
// Web（TunnelAppRoot）与桌面（DesktopTunnelRoot）共用，避免双实现漂移。
import { AssistRedeemError } from "./assistRedeem.js";
import { TunnelConnectError } from "./transport.js";

export function isRetryableTunnelConnectError(cause: unknown): boolean {
  if (cause instanceof TunnelConnectError) {
    return (
      cause.code === "network" ||
      cause.code === "hostOffline" ||
      cause.code === "invalidSessionCredential" ||
      cause.code === "connectTokenInvalid"
    );
  }
  if (cause instanceof AssistRedeemError) {
    return cause.kind === "network" || cause.kind === "generic";
  }
  return false;
}
