import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MOBILE_TOUCH_SIDEBAR_OVERLAY_QUERY,
  resolveInitialWorkspaceSidebarVisible,
  shouldApplyMobileTouchSidebarOverlay,
  shouldCollapseSidebarAfterConversationActivate,
} from "../src/lib/workspaceSidebarMobilePolicy.js";

type FakeMatchMedia = (query: string) => { matches: boolean };

// isCoarseTouchDevice 在调用点读取 window.matchMedia，这里用临时 window 桩模拟
// 手机浏览器 / 桌面浏览器 / 老旧浏览器三种环境，避免引入 DOM 测试框架。
function withFakeWindow(windowValue: unknown, run: () => void): void {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = windowValue;
  try {
    run();
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

const coarsePhoneMatchMedia: FakeMatchMedia = (query) => ({
  matches: query.includes("(hover: none)") && query.includes("(pointer: coarse)"),
});

const desktopMatchMedia: FakeMatchMedia = (query) => ({
  matches: query === "(hover: hover) and (pointer: fine)",
});

test("初始可见性：手机等触摸设备（hover: none + pointer: coarse）首屏默认收起侧栏", () => {
  withFakeWindow({ matchMedia: coarsePhoneMatchMedia }, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), false);
  });
});

test("初始可见性：桌面浏览器（可 hover、精确指针）保持默认展开侧栏", () => {
  withFakeWindow({ matchMedia: desktopMatchMedia }, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), true);
  });
});

test("初始可见性：window 存在但 matchMedia 不可用时保守回退为默认展开，不改变桌面现状", () => {
  withFakeWindow({}, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), true);
  });
});

test("初始可见性：非浏览器环境（无 window）保守回退为默认展开", () => {
  withFakeWindow(undefined, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), true);
  });
});

test("进入会话后收起：触摸设备且导航成功时收起侧栏", () => {
  assert.equal(
    shouldCollapseSidebarAfterConversationActivate({ proceeded: true, isCoarseTouch: true }),
    true,
  );
});

test("进入会话后收起：导航失败（只读 workspace、远程目标未连接）不收起", () => {
  assert.equal(
    shouldCollapseSidebarAfterConversationActivate({ proceeded: false, isCoarseTouch: true }),
    false,
  );
});

test("进入会话后收起：桌面精确指针设备行为不变，不收起", () => {
  assert.equal(
    shouldCollapseSidebarAfterConversationActivate({ proceeded: true, isCoarseTouch: false }),
    false,
  );
});

test("全屏覆盖判定：触摸设备窄视口且非远控壳时侧栏走全屏覆盖", () => {
  assert.equal(
    shouldApplyMobileTouchSidebarOverlay({
      matchesMobileTouchViewport: true,
      isWebRemoteControlShell: false,
    }),
    true,
  );
});

test("全屏覆盖判定：远控壳有自己的顶部导航形态，不走全屏覆盖", () => {
  assert.equal(
    shouldApplyMobileTouchSidebarOverlay({
      matchesMobileTouchViewport: true,
      isWebRemoteControlShell: true,
    }),
    false,
  );
});

test("全屏覆盖判定：桌面窄窗口与 iPad（≥768px 视口不匹配）不走全屏覆盖", () => {
  assert.equal(
    shouldApplyMobileTouchSidebarOverlay({
      matchesMobileTouchViewport: false,
      isWebRemoteControlShell: false,
    }),
    false,
  );
});

test("全屏覆盖判定：媒体查询同时约束窄视口与粗指针，避免 iPad / 桌面窄窗口误命中", () => {
  assert.match(MOBILE_TOUCH_SIDEBAR_OVERLAY_QUERY, /\(max-width: 767px\)/);
  assert.match(MOBILE_TOUCH_SIDEBAR_OVERLAY_QUERY, /\(hover: none\)/);
  assert.match(MOBILE_TOUCH_SIDEBAR_OVERLAY_QUERY, /\(pointer: coarse\)/);
});
