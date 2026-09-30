import assert from "node:assert/strict";
import test from "node:test";
import { resolveUserActionCatalogEntry } from "../src/lib/userActionTraceCatalog.js";

test("workbench.browser 目录包含头部切换按钮依赖的 open/close 动作", () => {
  const open = resolveUserActionCatalogEntry("workbench.browser", "open");
  const close = resolveUserActionCatalogEntry("workbench.browser", "close");
  assert.ok(open, "open 动作必须在目录中，否则按钮遥测静默丢弃");
  assert.ok(close, "close 动作必须在目录中，否则按钮遥测静默丢弃");
  assert.equal(open?.group, "core");
  assert.equal(close?.group, "core");
});
