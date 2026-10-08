// 模式菜单草稿切换的单元覆盖。
// 核心不变量（产品规则）：计划模式与评审模式互斥——二选一或不选；
// 权限单选（build/edit/yolo）与两者正交；评审关闭时协议字段保持缺省。
import test from "node:test";
import assert from "node:assert/strict";
import { after, beforeEach } from "node:test";
import { applyComposerModeSwitch } from "../src/v4/composer/composerModeSwitch.js";
import { applyComposerPlanTransition } from "../src/v4/composer/composerPlanTransition.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

function baseDraft(overrides: Partial<V4ComposerDraft> = {}): V4ComposerDraft {
  return {
    text: "",
    mode: "build",
    planEnabled: false,
    updatedAt: 0,
    ...overrides,
  };
}

test("enabling review turns off plan and freezes reviewEnabled", () => {
  const next = applyComposerModeSwitch(baseDraft({ planEnabled: true }), "review");
  assert.equal(next?.planEnabled, false);
  assert.equal(next?.reviewEnabled, true);
  assert.equal(next?.mode, "build");
});

test("enabling plan clears review (mutual exclusion)", () => {
  const next = applyComposerModeSwitch(baseDraft({ reviewEnabled: true }), "plan");
  assert.equal(next?.planEnabled, true);
  assert.equal(next?.reviewEnabled, undefined);
});

test("plan-off and review-off only clear their own flag", () => {
  const planOff = applyComposerModeSwitch(baseDraft({ planEnabled: true }), "plan-off");
  assert.equal(planOff?.planEnabled, false);
  assert.equal(planOff?.mode, "build");

  const reviewOff = applyComposerModeSwitch(baseDraft({ reviewEnabled: true }), "review-off");
  assert.equal(reviewOff?.reviewEnabled, undefined);
  assert.equal(reviewOff?.planEnabled, false);
});

test("permission radio switch keeps review untouched", () => {
  const next = applyComposerModeSwitch(baseDraft({ reviewEnabled: true }), "yolo");
  assert.equal(next?.mode, "yolo");
  assert.equal(next?.reviewEnabled, true);
  assert.equal(next?.planEnabled, false);
});

test("invalid mode value is rejected", () => {
  assert.equal(applyComposerModeSwitch(baseDraft(), "nonexistent"), null);
  assert.equal(applyComposerModeSwitch(baseDraft(), "auto"), null);
});

test("agent-side plan transition enabling plan also clears review", () => {
  const next = applyComposerPlanTransition(baseDraft({ reviewEnabled: true }), {
    toolCallId: "t1",
    planEnabled: true,
  });
  assert.equal(next.planEnabled, true);
  assert.equal(next.reviewEnabled, undefined);
});

// 旧版 UI 允许计划与评审同时开启；读取持久化草稿时按新约束归一化。
// composerDraftStore.getStorage() 走 window.localStorage，Node 测试用内存实现替换。
const storage = new Map<string, string>();
const storageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
} as Storage;

beforeEach(() => {
  storage.clear();
  (globalThis as { window?: unknown }).window = { localStorage: storageStub };
});

after(() => {
  storage.clear();
  delete (globalThis as { window?: unknown }).window;
});

test("legacy draft with plan and review both on keeps plan and drops review", () => {
  persistV4ComposerDraft("/ws", undefined, "session-1", {
    text: "",
    mode: "build",
    planEnabled: true,
    reviewEnabled: true,
    updatedAt: 0,
  });
  const draft = readV4ComposerDraft("/ws", undefined, "session-1");
  assert.equal(draft?.planEnabled, true);
  assert.equal(draft?.reviewEnabled, undefined);
});

test("legacy review-only draft is preserved as-is", () => {
  persistV4ComposerDraft("/ws", undefined, "session-2", {
    text: "",
    mode: "build",
    reviewEnabled: true,
    updatedAt: 0,
  });
  const draft = readV4ComposerDraft("/ws", undefined, "session-2");
  assert.equal(draft?.planEnabled, false);
  assert.equal(draft?.reviewEnabled, true);
});
