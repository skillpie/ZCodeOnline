// 连接门禁可见性状态机（唯一所有者）：刷新/首开默认不弹「连接到你的电脑」模态，
// 真实主界面（挂起态未登录空态）直接展示、连接在后台进行；只有定局失败（不可重试错误、需要登录、
// 自动重连窗口耗尽、本机无可连对象）才弹门禁。连接进行中的事件不改变可见性——
// 门禁已在屏幕上（手动重连）就保持展示，否则保持后台。独立于 React，node:test 可直接驱动。

export type GateStatus = "idle" | "pairing" | "connecting" | "disconnected";

export interface GateState {
  visible: boolean;
  status: GateStatus;
  error: string | null;
  needsLogin: boolean;
}

/** 初始态：不弹门禁（连接在后台进行），真实主界面以挂起态未登录空态呈现。 */
export const initialGateState: GateState = {
  visible: false,
  status: "idle",
  error: null,
  needsLogin: false,
};

export type GateEvent =
  // 连接/兑换开始：后台进行，visible 不变。
  | { kind: "connectStart" }
  // 本地发现命中 → 自动配对中：后台进行，visible 不变。
  | { kind: "pairingStart" }
  // 连接成功：收起门禁并清登录提示。
  | { kind: "connectSuccess" }
  // 断开后排入自动重连：visible 不变（后台重试；手动重连场景门禁本就在屏幕上）。
  | { kind: "retryScheduled"; message: string }
  // 配对前需要登录：弹门禁给登录入口。
  | { kind: "needsLogin" }
  // 定局失败需用户处理：弹门禁（status 区分「可点重连」与「重新走引导」两档展示）。
  | { kind: "gateError"; status: "idle" | "disconnected"; message: string | null };

export function nextGateState(current: GateState, event: GateEvent): GateState {
  switch (event.kind) {
    case "connectStart":
      return { ...current, status: "connecting", error: null };
    case "pairingStart":
      return { ...current, status: "pairing", error: null };
    case "connectSuccess":
      return { visible: false, status: "idle", error: null, needsLogin: false };
    case "retryScheduled":
      return { ...current, status: "connecting", error: event.message };
    case "needsLogin":
      return { ...current, visible: true, status: "idle", needsLogin: true };
    case "gateError":
      return { ...current, visible: true, status: event.status, error: event.message };
  }
}
