import assert from "node:assert/strict";
import test from "node:test";
import { resolveMainBreadcrumbFallbackLabel } from "../src/settings/AutomationsMainBreadcrumbFrame.js";

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
