import assert from "node:assert/strict";
import test from "node:test";
import { resolveSidebarToggleVariant } from "../src/desktopTopOverlayLayout.js";

test("web（平台标志缺省）渲染 plain 折叠按钮，保证收起后仍有展开入口", () => {
  assert.equal(resolveSidebarToggleVariant({}), "plain");
});

test("macOS 桌面沿用 plain 图标按钮，行为不变", () => {
  assert.equal(
    resolveSidebarToggleVariant({ isWindowsDesktop: false, isLinuxDesktop: false }),
    "plain",
  );
});

test("Windows / Linux 自绘标题栏桌面沿用 Logo hover 变体，行为不变", () => {
  assert.equal(resolveSidebarToggleVariant({ isWindowsDesktop: true }), "logoHover");
  assert.equal(resolveSidebarToggleVariant({ isLinuxDesktop: true }), "logoHover");
});
