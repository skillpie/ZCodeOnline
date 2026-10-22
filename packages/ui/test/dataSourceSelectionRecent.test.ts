// 数据源跨会话记忆的单元覆盖（specs/data-source.md §7.1 跨会话记忆；用户决策改为按项目记忆）。
// 核心不变量：显式选择与取消（null）都按项目记忆；同一项目下的会话共享选择；
// 未归属项目的 workspace 回退按工作区隔离；不同项目 / 不同 workspace 互相隔离。
import { test } from "vitest";
import assert from "node:assert/strict";
import { afterAll as after, beforeEach } from "vitest";
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

test("select and deselect both persist as the project's last decision", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", "proj-1", storage);
  assert.equal(readDataSourceSelectionRecent("/ws", undefined, "proj-1", storage), "ds-1");
  writeDataSourceSelectionRecent("/ws", undefined, null, "proj-1", storage);
  assert.equal(readDataSourceSelectionRecent("/ws", undefined, "proj-1", storage), null);
});

test("memory is keyed per project: same project shares, different projects isolate", () => {
  // 同项目的两个 workspace（worktree / 分屏会话）共享选择。
  writeDataSourceSelectionRecent("/ws-main", undefined, "ds-1", "proj-1", storage);
  assert.equal(readDataSourceSelectionRecent("/ws-worktree", undefined, "proj-1", storage), "ds-1");
  // 不同项目互不读取。
  assert.equal(readDataSourceSelectionRecent("/ws-other", undefined, "proj-2", storage), null);
});

test("unclassified workspaces fall back to per-workspace memory", () => {
  writeDataSourceSelectionRecent("/ws-a", "remote-1", "ds-a", null, storage);
  assert.equal(readDataSourceSelectionRecent("/ws-a", "remote-1", null, storage), "ds-a");
  // 同路径不同 identity 视为不同 workspace，互不读取。
  assert.equal(readDataSourceSelectionRecent("/ws-a", undefined, null, storage), null);
  // 有项目归属的读取不会落到 workspace 记忆桶。
  writeDataSourceSelectionRecent("/ws-b", undefined, "ds-b", null, storage);
  assert.equal(readDataSourceSelectionRecent("/ws-b", undefined, "proj-2", storage), null);
});

test("corrupted records degrade to unselected", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", "proj-1", storage);
  const key = [...map.keys()][0];
  for (const raw of ["not-json", "[]", JSON.stringify({ dataSourceId: 42 })]) {
    map.set(key, raw);
    assert.equal(readDataSourceSelectionRecent("/ws", undefined, "proj-1", storage), null);
  }
});

test("initializeNewTaskDraft restores last project selection", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", "proj-1", storage);
  const next = initializeNewTaskDraft(baseDraft(), "/ws", undefined, view, undefined, "proj-1");
  assert.equal(next.dataSourceId, "ds-1");
});

test("initializeNewTaskDraft keeps the draft's own binding over memory", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", "proj-1", storage);
  const next = initializeNewTaskDraft(
    baseDraft({ dataSourceId: "ds-2" }),
    "/ws",
    undefined,
    view,
    undefined,
    "proj-1",
  );
  assert.equal(next.dataSourceId, "ds-2");
});

test("explicit deselection memory keeps new task unselected", () => {
  writeDataSourceSelectionRecent("/ws", undefined, "ds-1", "proj-1", storage);
  writeDataSourceSelectionRecent("/ws", undefined, null, "proj-1", storage);
  const next = initializeNewTaskDraft(baseDraft(), "/ws", undefined, view, undefined, "proj-1");
  assert.equal(next.dataSourceId, undefined);
});

test("initializeNewTaskDraft stays unselected without any memory", () => {
  const next = initializeNewTaskDraft(baseDraft(), "/ws", undefined, view, undefined, "proj-1");
  assert.equal(next.dataSourceId, undefined);
});

test("initializeNewTaskDraft reads memory per project", () => {
  writeDataSourceSelectionRecent("/ws-a", undefined, "ds-a", "proj-1", storage);
  writeDataSourceSelectionRecent("/ws-b", undefined, null, "proj-2", storage);
  assert.equal(
    initializeNewTaskDraft(baseDraft(), "/ws-a", undefined, view, undefined, "proj-1").dataSourceId,
    "ds-a",
  );
  // proj-2 上一次是取消：新对话保持未选择，也不读取 proj-1 的记忆。
  assert.equal(
    initializeNewTaskDraft(baseDraft(), "/ws-b", undefined, view, undefined, "proj-2").dataSourceId,
    undefined,
  );
});

test("without project id the memory falls back to per-workspace isolation", () => {
  writeDataSourceSelectionRecent("/ws-a", undefined, "ds-a", null, storage);
  assert.equal(
    initializeNewTaskDraft(baseDraft(), "/ws-a", undefined, view, undefined, undefined)
      .dataSourceId,
    "ds-a",
  );
  assert.equal(
    initializeNewTaskDraft(baseDraft(), "/ws-b", undefined, view, undefined, undefined)
      .dataSourceId,
    undefined,
  );
});
