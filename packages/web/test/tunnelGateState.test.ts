import assert from "node:assert/strict";
import { test } from "node:test";
import { initialGateState, nextGateState, type GateState } from "../src/tunnel/gateState.js";

// 门禁可见性验收（specs/web-tunnel.md §3.3）：刷新/首开默认不弹「连接到你的电脑」模态，
// 连接全程在后台进行（骨架主界面 + 底部状态条），仅定局失败/需要用户操作时弹出。

const start: GateState = initialGateState;

test("初始态不弹门禁：刷新后直接展示主界面骨架、连接在后台进行", () => {
  assert.equal(start.visible, false);
  assert.equal(start.status, "idle");
  assert.equal(start.error, null);
  assert.equal(start.needsLogin, false);
});

test("后台连接事件（连接/配对/自动重连排入）不改变可见性", () => {
  const connecting = nextGateState(start, { kind: "connectStart" });
  assert.equal(connecting.visible, false);
  assert.equal(connecting.status, "connecting");

  const pairing = nextGateState(connecting, { kind: "pairingStart" });
  assert.equal(pairing.visible, false);
  assert.equal(pairing.status, "pairing");

  const retrying = nextGateState(pairing, {
    kind: "retryScheduled",
    message: "连接已断开，正在自动重连…",
  });
  assert.equal(retrying.visible, false);
  assert.equal(retrying.status, "connecting");
  assert.equal(retrying.error, "连接已断开，正在自动重连…");
});

test("连接成功收起门禁并清除登录提示与错误", () => {
  const failed = nextGateState(start, { kind: "needsLogin" });
  const recovered = nextGateState(failed, { kind: "connectSuccess" });
  assert.equal(recovered.visible, false);
  assert.equal(recovered.needsLogin, false);
  assert.equal(recovered.error, null);
});

test("定局失败弹门禁：idle 档（引导重新配对）与 disconnected 档（一键重连）", () => {
  const gate = nextGateState(start, {
    kind: "gateError",
    status: "idle",
    message: "本机未发现可连接的 ZCode",
  });
  assert.equal(gate.visible, true);
  assert.equal(gate.status, "idle");
  assert.equal(gate.error, "本机未发现可连接的 ZCode");

  const dropped = nextGateState(start, {
    kind: "gateError",
    status: "disconnected",
    message: "自动重连未成功，请点击「重新连接」。",
  });
  assert.equal(dropped.visible, true);
  assert.equal(dropped.status, "disconnected");
});

test("需要登录弹门禁并保留重连中状态之外的可操作入口", () => {
  const gate = nextGateState(start, { kind: "needsLogin" });
  assert.equal(gate.visible, true);
  assert.equal(gate.status, "idle");
  assert.equal(gate.needsLogin, true);
});

test("手动重连场景：门禁已在屏幕上时后台重试保持可见", () => {
  const gate = nextGateState(start, {
    kind: "gateError",
    status: "disconnected",
    message: "自动重连未成功，请点击「重新连接」。",
  });
  const retrying = nextGateState(gate, { kind: "connectStart" });
  assert.equal(retrying.visible, true);
  assert.equal(retrying.status, "connecting");
  // 重试失败再次排入自动重连：门禁保持展示并更新状态文案。
  const retryScheduled = nextGateState(retrying, {
    kind: "retryScheduled",
    message: "连接已断开，正在自动重连…",
  });
  assert.equal(retryScheduled.visible, true);
  assert.equal(retryScheduled.status, "connecting");
});
