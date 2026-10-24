import { describe, expect, it } from "vitest";
import { resolveTopOverlayLeadingPaddingClass } from "@/WorkspaceHeader.js";

// WorkspaceHeader 与 Side Pane 完整视图 tab 栏共用：侧栏收起时给左上角浮层按钮组让位。
describe("resolveTopOverlayLeadingPaddingClass", () => {
  it("does not reserve space while the sidebar is visible", () => {
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: true, isMacDesktop: true }),
    ).toBe(false);
  });

  it("reserves the macOS traffic lights plus overlay buttons", () => {
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false, isMacDesktop: true }),
    ).toBe("pl-58");
    expect(
      resolveTopOverlayLeadingPaddingClass({
        isSidebarVisible: false,
        isMacDesktop: true,
        isMacFullscreen: true,
        hasUpdateReady: true,
      }),
    ).toBe("pl-48");
  });

  it("reserves only the overlay buttons on Windows and Linux", () => {
    expect(resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false })).toBe("pl-38");
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false, hasUpdateReady: true }),
    ).toBe("pl-44");
  });

  it("reserves a narrower strip when task navigation buttons are hidden (mobile compact)", () => {
    // 移动端隐藏前进/后退后浮层只剩 侧栏开关+新建（+更新按钮），标题让位留白收窄整体左移。
    expect(
      resolveTopOverlayLeadingPaddingClass({
        isSidebarVisible: false,
        hideTaskNavigationButtons: true,
      }),
    ).toBe("pl-24");
    expect(
      resolveTopOverlayLeadingPaddingClass({
        isSidebarVisible: false,
        hasUpdateReady: true,
        hideTaskNavigationButtons: true,
      }),
    ).toBe("pl-30");
  });

  it("keeps the macOS strip unchanged when task navigation buttons are hidden", () => {
    // mac 窄窗桌面保留原留白：数值未经视觉验证，宁松勿叠（留白偏大不会遮挡标题）。
    expect(
      resolveTopOverlayLeadingPaddingClass({
        isSidebarVisible: false,
        isMacDesktop: true,
        hideTaskNavigationButtons: true,
      }),
    ).toBe("pl-58");
  });
});
