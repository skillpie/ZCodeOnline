// M4 门禁：compact（v4 composer slash 命令 `/compact`）。
// 证据层 L3：首轮固定回复形成历史 → composer 输入 `/compact` → handleSendText 识别 slash →
// dispatchCommand("compact", baseRevision) → v4-bridge compactSession → CompactStarted/Completed
// 事件 → reducer onCompactLifecycle → timelineMarker compact/manual/success。
// 证明 slash 命令入口 + compact 全链路（命令面已桥接，仅补 UI 触发）。
// 追加：context 容量面板「压缩」按钮入口 —— hover 触发器打开面板点击按钮走同一
// dispatchSlashCommand("compact") 链路，并断言压缩完成后 usage snapshot 回流、容量下降。
import {
  TID_CHAT_CONTEXT_USAGE_COMPACT,
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_MODEL_CONFIG,
} from "@zcode/shared/test-ids";
import assert from "node:assert/strict";
import { clearAppData, setInputValueByTestIdDom } from "../helpers/desktop-app.js";
import {
  clickV4Send,
  getV4CompactMarkers,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

/** 读取 composer e2e 锚点上的 contextWindow.usedTokens（usage snapshot 投影）。 */
function readContextUsedTokens(): Promise<number | null> {
  return browser.execute((modelConfigTestId) => {
    const raw =
      document.querySelector<HTMLElement>(`[data-testid="${modelConfigTestId}"]`)?.dataset
        .usageUsed ?? "";
    const value = Number(raw);
    return raw !== "" && Number.isFinite(value) ? value : null;
  }, TID_V4_MODEL_CONFIG);
}

describe("v4 M4 门禁：compact（/compact slash）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("首轮完成 → /compact → 时间线出现 manual compact success marker", async () => {
    await prepareV4ConversationE2E();

    // 首轮：形成一段可被压缩的历史
    await sendV4Prompt("E2E_V4_COMPACT_SEED 请回复种子");
    await waitForV4TimelineContaining("V4_COMPACT_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态",
      45000,
    );

    // composer 输入 /compact slash 命令并发送（不走 sendText，走 compact 命令）
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();

    // v4 投影产出结构化 marker；文案会随 locale 改变，不参与定位。
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
  });

  it("context 面板「压缩」按钮 → 第二次 manual compact → 容量回落", async () => {
    // slash compact 已完成；压缩后历史只剩摘要（夹具低 token 响应），等待投影稳定后读基线。
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "第一次 compact 后没有回到空闲态",
      45000,
    );
    const markersBefore = (await getV4CompactMarkers()).filter(
      (marker) => marker.origin === "manual" && marker.status === "success",
    ).length;
    assert.ok(markersBefore >= 1, "前置 slash compact marker 不存在");
    const usedBefore = await readContextUsedTokens();
    assert.ok(
      usedBefore !== null && usedBefore > 0,
      `第一次 compact 后没有可读的上下文容量投影: ${String(usedBefore)}`,
    );

    // hover context 触发器打开容量面板，点击标题旁「压缩」图标按钮。
    const trigger = await $(`[data-testid="${TID_CHAT_CONTEXT_USAGE_TRIGGER}"]`);
    await trigger.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Context usage trigger 没有出现",
    });
    await trigger.moveTo();
    const compressButton = await $(`[data-testid="${TID_CHAT_CONTEXT_USAGE_COMPACT}"]`);
    await compressButton.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "容量面板压缩按钮没有出现",
    });
    await compressButton.click();

    // 同一 compact 命令链路：出现第二条 manual success marker。
    await browser.waitUntil(
      async () =>
        (await getV4CompactMarkers()).filter(
          (marker) => marker.origin === "manual" && marker.status === "success",
        ).length >=
        markersBefore + 1,
      { timeout: 90000, timeoutMsg: "压缩按钮没有产出第二条 manual compact success marker" },
    );

    // 压缩完成后 CLI 推送新的 usage snapshot：容量必须回落到按钮点击前的值以下。
    await browser.waitUntil(
      async () => {
        const usedAfter = await readContextUsedTokens();
        return usedAfter !== null && usedAfter < (usedBefore ?? 0);
      },
      { timeout: 60000, timeoutMsg: `压缩完成后上下文容量没有回落: before=${String(usedBefore)}` },
    );
  });
});
