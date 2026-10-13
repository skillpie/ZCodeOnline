import assert from "node:assert/strict";
import { describe, expect, it, test } from "vitest";
import {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
  resolveUserActionCatalogEntry,
} from "../src/lib/userActionTraceCatalog.js";

test("workbench.browser 目录包含头部切换按钮依赖的 open/close 动作", () => {
  const open = resolveUserActionCatalogEntry("workbench.browser", "open");
  const close = resolveUserActionCatalogEntry("workbench.browser", "close");
  assert.ok(open, "open 动作必须在目录中，否则按钮遥测静默丢弃");
  assert.ok(close, "close 动作必须在目录中，否则按钮遥测静默丢弃");
  assert.equal(open?.group, "core");
  assert.equal(close?.group, "core");
});

describe("user action trace catalog", () => {
  it("固定 24 个 Core 与 15 个 Settings 叶子 feature", () => {
    expect(Object.keys(CORE_USER_ACTION_FEATURES)).toHaveLength(24);
    expect(Object.keys(SETTINGS_USER_ACTION_FEATURES)).toHaveLength(15);
    // 本地新增 workbench.browser open/close（内嵌浏览器头部切换），目录 95 条。
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "core")).toHaveLength(95);
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "settings")).toHaveLength(44);
  });

  it("feature/action 组合唯一且不使用动态标识", () => {
    const keys = USER_ACTION_CATALOG.map((entry) => `${entry.featureId}:${entry.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry.featureId).toMatch(/^[a-z]+(?:[._][a-z]+)+$/u);
      expect(entry.action).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(entry.featureId).not.toMatch(/taskId|workspacePath|pluginId/iu);
    }
  });

  it("不声明 /event/report sink", () => {
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry).not.toHaveProperty("eventPolicy");
      expect(entry).not.toHaveProperty("elementName");
    }
  });
});
