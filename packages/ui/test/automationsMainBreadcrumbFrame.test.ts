// @vitest-environment jsdom
import assert from "node:assert/strict";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { resolveMainBreadcrumbFallbackLabel } from "../src/settings/AutomationsMainBreadcrumbFrame.js";

afterEach(cleanup);

test("无 reporter 上报（items 为空）回退显示 sectionLabel：桌面端技能市场顶栏不再是空白带", () => {
  assert.equal(resolveMainBreadcrumbFallbackLabel([], "技能市场"), "技能市场");
  assert.equal(resolveMainBreadcrumbFallbackLabel([], "Skill Marketplace"), "Skill Marketplace");
});

test("仅 section 一项（子页上报零条目）同样回退，避免门阈内出现空条", () => {
  assert.equal(resolveMainBreadcrumbFallbackLabel([{ label: "自动化" }], "自动化"), "自动化");
});

test("reporter 上报后（section + 页面条目 ≥2）不回退，交给 SettingsHeaderBreadcrumb 渲染", () => {
  const items = [{ label: "技能市场" }, { label: "已安装技能", onSelect: () => {} }];
  assert.equal(resolveMainBreadcrumbFallbackLabel(items, "技能市场"), null);
});

describe("AutomationsMainBreadcrumbFrame", () => {
  it("projects automation edit navigation into the workspace drag header", async () => {
    const onBack = vi.fn();
    render(
      createElement(
        AutomationsMainBreadcrumbFrame,
        {
          isDesktop: true,
          sectionLabel: "Automations",
          ariaLabel: "Automation path",
        },
        createElement(SettingsBreadcrumbReporter, {
          items: [{ label: "Daily summary" }],
          onSectionSelect: onBack,
        }),
      ),
    );

    expect((await screen.findByRole("navigation", { name: "Automation path" })).textContent).toBe(
      "AutomationsDaily summary",
    );
    screen.getByRole("button", { name: "Automations" }).click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps the desktop drag header blank for the list level", () => {
    render(
      createElement(AutomationsMainBreadcrumbFrame, {
        isDesktop: true,
        sectionLabel: "Automations",
        ariaLabel: "Automation path",
        children: createElement("div", null, "List"),
      }),
    );

    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByTestId("automations-main-drag-region")).not.toBeNull();
  });
});
