import assert from "node:assert/strict";
import test from "node:test";
import { resolveInitialWorkspaceSidebarVisible } from "../src/lib/workspaceSidebarInitialVisibility.js";

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

test("手机等触摸设备（hover: none + pointer: coarse）首屏默认收起侧栏", () => {
  withFakeWindow({ matchMedia: coarsePhoneMatchMedia }, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), false);
  });
});

test("桌面浏览器（可 hover、精确指针）保持默认展开侧栏", () => {
  withFakeWindow({ matchMedia: desktopMatchMedia }, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), true);
  });
});

test("window 存在但 matchMedia 不可用时保守回退为默认展开，不改变桌面现状", () => {
  withFakeWindow({}, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), true);
  });
});

test("非浏览器环境（无 window）保守回退为默认展开", () => {
  withFakeWindow(undefined, () => {
    assert.equal(resolveInitialWorkspaceSidebarVisible(), true);
  });
});
