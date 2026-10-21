// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSidebarNavigation } from "@/project-sidebar/ProjectSidebarNavigation.js";

// v3.16.2 起 sidebar 切换为官方 ProjectSidebar（packages/ui/src/project-sidebar/）。
// 旧单体侧栏的手机远控布局用例（单滚动区/归档按钮切换 Close/远端任务索引合并）
// 随官方重构被取代：列表滚动收敛进统一 ScrollFadeViewport，归档管理迁移到设置页，
// 任务索引由 HomeOnlyWorkspaceRows / 移动 shell 承接。本文件保留仍成立的 fork 决策：
// D37（手机 home-only 不承载自动化入口）与技能市场移植入口。

const { setPendingSettingsSectionMock } = vi.hoisted(() => ({
  setPendingSettingsSectionMock: vi.fn(),
}));

vi.mock("@/NewTaskButtonGroup.js", () => ({ NewTaskButtonGroup: () => null }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderNavigation(
  propsOverride: Partial<Parameters<typeof ProjectSidebarNavigation>[0]["props"]> = {},
) {
  const onOpenPluginStore = vi.fn();
  const onOpenSkillMarket = vi.fn();
  const props = {
    onOpenPluginStore,
    onOpenSkillMarket,
    skillMarketActive: false,
    ...propsOverride,
  } as Parameters<typeof ProjectSidebarNavigation>[0]["props"];
  render(createElement(ProjectSidebarNavigation, { props, onCreate: vi.fn() }));
  return { onOpenPluginStore, onOpenSkillMarket };
}

describe("ProjectSidebar web remote mobile layout", () => {
  it("手机 home-only 不渲染自动化入口，插件与技能市场保留（D37）", () => {
    // ProjectSidebar 在 home-only（service 为空）时向 Navigation 传 onOpenAutomations: undefined。
    renderNavigation({ onOpenAutomations: undefined });

    expect(screen.queryByRole("button", { name: "workspace.openScheduledSettings" })).toBeNull();
    expect(screen.getByTestId("plugin-store-sidebar-open")).toBeTruthy();
    expect(screen.getByTestId("skill-market-sidebar-open")).toBeTruthy();
  });

  it("opens the workspace plugin marketplace from the home shortcut", () => {
    const { onOpenPluginStore } = renderNavigation();
    fireEvent.click(screen.getByRole("button", { name: "workspace.openPluginsSettings" }));

    expect(onOpenPluginStore).toHaveBeenCalledTimes(1);
    expect(setPendingSettingsSectionMock).not.toHaveBeenCalled();
  });

  it("技能市场入口渲染在插件市场之后且可打开（fork 移植能力）", () => {
    const { onOpenSkillMarket } = renderNavigation();
    const pluginsButton = screen.getByRole("button", { name: "workspace.openPluginsSettings" });
    const skillButton = screen.getByRole("button", { name: "workspace.openSkillMarket" });

    expect(
      pluginsButton.compareDocumentPosition(skillButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(skillButton);
    expect(onOpenSkillMarket).toHaveBeenCalledTimes(1);
  });

  it("places plugins immediately after automations on the desktop home sidebar", () => {
    renderNavigation({ onOpenAutomations: vi.fn() });
    const automationsButton = screen.getByRole("button", {
      name: "workspace.openScheduledSettings",
    });
    const pluginsButton = screen.getByRole("button", { name: "workspace.openPluginsSettings" });

    expect(pluginsButton.querySelector("svg")?.classList.contains("lucide-blocks")).toBe(true);
    expect(
      automationsButton.compareDocumentPosition(pluginsButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not keep the removed task toolbar search state", () => {
    const sidebarSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebar.tsx"),
      "utf8",
    );

    expect(sidebarSource).not.toContain("webRemoteTaskSearchOpen");
    expect(sidebarSource).not.toContain("webRemoteTaskSearchQuery");
  });

  it("手机 home-only 的自动化入口由 ProjectSidebar 统一门控（D37 防回归）", () => {
    const sidebarSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/project-sidebar/index.tsx"),
      "utf8",
    );

    expect(sidebarSource).toContain("homeOnlySwitcher");
    expect(sidebarSource).toContain("onOpenAutomations: undefined");
  });
});
