// fork 数据源继承的单元覆盖（specs/data-source.md §7.1 fork 继承）。
// 核心不变量：child scope 在切换前被播种父会话草稿的 dataSourceId；只播种数据源，
// 正文/mode/模型选择不继承；父未选择不预填；child 已有草稿不覆盖；workspace 隔离。
import test from "node:test";
import assert from "node:assert/strict";
import { after, beforeEach } from "node:test";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";
import { seedForkedSessionDraft } from "../src/v4/composer/newTaskDraft.js";

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    },
    map,
  };
}

let storage: ReturnType<typeof createMemoryStorage>["storage"];

beforeEach(() => {
  ({ storage } = createMemoryStorage());
  // composerDraftStore 默认走 window.localStorage，Node 测试用内存实现替换。
  (globalThis as { window?: unknown }).window = { localStorage: storage };
});

after(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("seeds the parent's data source binding into the child scope", () => {
  persistV4ComposerDraft("/ws", undefined, "parent-1", {
    text: "父草稿正文",
    mode: "build",
    dataSourceId: "ds-1",
  });
  seedForkedSessionDraft({
    workspacePath: "/ws",
    workspaceIdentity: undefined,
    parentSessionId: "parent-1",
    childSessionId: "child-1",
  });
  const seeded = readV4ComposerDraft("/ws", undefined, "child-1");
  assert.equal(seeded?.dataSourceId, "ds-1");
  // 只播种数据源：正文/mode/模型选择不随 fork 继承，由 child 会话自身投影初始化。
  assert.equal(seeded?.text, "");
  assert.equal(seeded?.mode, undefined);
  assert.equal(seeded?.modelSelection, undefined);
  assert.equal(seeded?.initializeFromNewTask, undefined);
});

test("unselected parent keeps the child unselected", () => {
  persistV4ComposerDraft("/ws", undefined, "parent-1", { text: "", mode: "build" });
  seedForkedSessionDraft({
    workspacePath: "/ws",
    workspaceIdentity: undefined,
    parentSessionId: "parent-1",
    childSessionId: "child-1",
  });
  assert.equal(readV4ComposerDraft("/ws", undefined, "child-1"), null);
});

test("does not overwrite an existing child draft", () => {
  persistV4ComposerDraft("/ws", undefined, "parent-1", { text: "", dataSourceId: "ds-1" });
  persistV4ComposerDraft("/ws", undefined, "child-1", { text: "已有草稿", dataSourceId: "ds-2" });
  seedForkedSessionDraft({
    workspacePath: "/ws",
    workspaceIdentity: undefined,
    parentSessionId: "parent-1",
    childSessionId: "child-1",
  });
  const existing = readV4ComposerDraft("/ws", undefined, "child-1");
  assert.equal(existing?.dataSourceId, "ds-2");
  assert.equal(existing?.text, "已有草稿");
});

test("parent draft is resolved within the same workspace", () => {
  persistV4ComposerDraft("/ws-a", "remote-1", "parent-1", { text: "", dataSourceId: "ds-a" });
  seedForkedSessionDraft({
    workspacePath: "/ws-a",
    workspaceIdentity: "remote-2",
    parentSessionId: "parent-1",
    childSessionId: "child-1",
  });
  assert.equal(readV4ComposerDraft("/ws-a", "remote-2", "child-1"), null);
});

test("ignores blank child session ids", () => {
  persistV4ComposerDraft("/ws", undefined, "parent-1", { text: "", dataSourceId: "ds-1" });
  seedForkedSessionDraft({
    workspacePath: "/ws",
    workspaceIdentity: undefined,
    parentSessionId: "parent-1",
    childSessionId: "   ",
  });
  assert.equal(readV4ComposerDraft("/ws", undefined, "   "), null);
  assert.equal(readV4ComposerDraft("/ws", undefined, "child-1"), null);
});
