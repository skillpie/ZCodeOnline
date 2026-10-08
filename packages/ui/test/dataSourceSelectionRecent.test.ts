// 数据源跨会话记忆的单元覆盖（specs/data-source.md §7.1 跨会话记忆）。
// 核心不变量：显式选择与取消（null）都按 workspace 记忆；新任务草稿初始化恢复
// 上一次结果；不同 workspace（workspaceIdentity / workspacePath）互相隔离。
import test from "node:test";
import assert from "node:assert/strict";
import { after, beforeEach } from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import {
  readDataSourceSelectionRecent,
  writeDataSourceSelectionRecent,
} from "../src/lib/dataSourceSelectionRecent.js";
import { initializeNewTaskDraft } from "../src/v4/composer/newTaskDraft.js";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

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
let map: ReturnType<typeof createMemoryStorage>["map"];

beforeEach(() => {
  ({ storage, map } = createMemoryStorage());
  // newTaskDraft 默认走 window.localStorage，Node 测试用内存实现替换。
  (globalThis as { window?: unknown }).window = { localStorage: storage };
});

after(() => {
  delete (globalThis as { window?: unknown }).window;
});

function baseDraft(overrides: Partial<V4ComposerDraft> = {}): V4ComposerDraft {
  return { text: "", updatedAt: 0, ...overrides };
}

const view = null as unknown as ModelSelectionView;

test("select and deselect both persist as the workspace's last decision", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", storage);
  assert.equal(readDataSourceSelectionRecent("/ws", undefined, storage), "ds-1");
  writeDataSourceSelectionRecent("/ws", undefined, null, storage);
  assert.equal(readDataSourceSelectionRecent("/ws", undefined, storage), null);
});

test("memory is isolated per workspace identity and path", () => {
  writeDataSourceSelectionRecent("/ws-a", "remote-1", "ds-a", storage);
  writeDataSourceSelectionRecent("/ws-b", undefined, "ds-b", storage);
  assert.equal(readDataSourceSelectionRecent("/ws-a", "remote-1", storage), "ds-a");
  // 同路径不同 identity 视为不同 workspace，互不读取。
  assert.equal(readDataSourceSelectionRecent("/ws-a", undefined, storage), null);
  assert.equal(readDataSourceSelectionRecent("/ws-b", "other", storage), null);
});

test("corrupted records degrade to unselected", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", storage);
  const key = [...map.keys()][0];
  for (const raw of ["not-json", "[]", JSON.stringify({ dataSourceId: 42 })]) {
    map.set(key, raw);
    assert.equal(readDataSourceSelectionRecent("/ws", undefined, storage), null);
  }
});

test("initializeNewTaskDraft restores last workspace selection", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", storage);
  const next = initializeNewTaskDraft(baseDraft(), "/ws", undefined, view);
  assert.equal(next.dataSourceId, "ds-1");
});

test("initializeNewTaskDraft keeps the draft's own binding over memory", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", storage);
  const next = initializeNewTaskDraft(baseDraft({ dataSourceId: "ds-2" }), "/ws", undefined, view);
  assert.equal(next.dataSourceId, "ds-2");
});

test("explicit deselection memory keeps new task unselected", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", storage);
  writeDataSourceSelectionRecent("/ws", undefined, null, storage);
  const next = initializeNewTaskDraft(baseDraft(), "/ws", undefined, view);
  assert.equal(next.dataSourceId, undefined);
});

test("initializeNewTaskDraft stays unselected without any memory", () => {
  const next = initializeNewTaskDraft(baseDraft(), "/ws", undefined, view);
  assert.equal(next.dataSourceId, undefined);
});

test("initializeNewTaskDraft reads memory per workspace", () => {
  writeDataSourceSelectionRecent("/ws-a", "remote-1", "ds-a", storage);
  writeDataSourceSelectionRecent("/ws-b", undefined, null, storage);
  assert.equal(initializeNewTaskDraft(baseDraft(), "/ws-a", "remote-1", view).dataSourceId, "ds-a");
  // B workspace 上一次是取消：新对话保持未选择，也不读取 A 的记忆。
  assert.equal(
    initializeNewTaskDraft(baseDraft(), "/ws-b", undefined, view).dataSourceId,
    undefined,
  );
});
