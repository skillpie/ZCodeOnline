export { RemoteServiceAccess } from "./remoteServiceAccess.js";
export type { IServiceAccessor } from "@zcode/services";
export { connectViaProtocol, connectViaWebSocket } from "./websocket.js";
export type { WebSocketConnectionCloseEvent } from "./websocket.js";
export { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";
export type { MessagePortServiceConnection } from "./messageport.js";
// 隧道客户端共享层（specs/web-tunnel.md §3.4/§5.9）：Web 与桌面 renderer 共用的
// relay 数据面传输、远程码兑换错误语义与自动重连调度器。
export {
  connectTunnelServices,
  connectTunnelTransport,
  TunnelConnectError,
} from "./tunnel/transport.js";
export type {
  TunnelBootstrap,
  TunnelTransport,
  TunnelTransportOptions,
} from "./tunnel/transport.js";
export {
  assertRedeemResult,
  AssistRedeemError,
  redeemAssistCodeViaEndpoint,
} from "./tunnel/assistRedeem.js";
export type { AssistRedeemResult } from "./tunnel/assistRedeem.js";
export { backoffDelayMs, createAutoReconnect } from "./tunnel/autoReconnect.js";
export type { AutoReconnectController, AutoReconnectOptions } from "./tunnel/autoReconnect.js";
export { isRetryableTunnelConnectError } from "./tunnel/retryable.js";
