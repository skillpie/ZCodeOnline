import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearStoredCodeRepositoryUrl,
  loadStoredCodeRepositoryUrl,
  saveStoredCodeRepositoryUrl,
} from "../src/codeRepositorySettings.js";
import { createStoredHttpUrlSetting, normalizeExternalHttpUrl } from "../src/storedUrlSetting.js";

// 自定义代码仓库设置：默认空（不显示侧边栏入口）、保存/清除 roundtrip、
// 非法输入拦截与变更通知（侧边栏经 useSyncExternalStore 订阅版本号）。
// node:test 无 localStorage，用内存实现替换。

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  } as Storage;
});

after(() => {
  storage.clear();
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

test("默认未设置：读取返回 null（侧边栏入口隐藏）", () => {
  assert.equal(loadStoredCodeRepositoryUrl(), null);
});

test("保存/读取 roundtrip；归一化写入；非法输入不落库", () => {
  assert.equal(
    saveStoredCodeRepositoryUrl("  https://git.example.com/org/repo  "),
    "https://git.example.com/org/repo",
  );
  assert.equal(loadStoredCodeRepositoryUrl(), "https://git.example.com/org/repo");
  assert.equal(saveStoredCodeRepositoryUrl("javascript:alert(1)"), null);
  assert.equal(saveStoredCodeRepositoryUrl("not-a-url"), null);
  assert.equal(saveStoredCodeRepositoryUrl("   "), null);
  assert.equal(loadStoredCodeRepositoryUrl(), "https://git.example.com/org/repo");
});

test("清除后回到未设置态", () => {
  saveStoredCodeRepositoryUrl("https://git.example.com/org/repo");
  clearStoredCodeRepositoryUrl();
  assert.equal(loadStoredCodeRepositoryUrl(), null);
});

test("storedUrlSetting：save/clear 触发订阅与版本号递增，非法保存不通知", () => {
  const setting = createStoredHttpUrlSetting("test-stored-url");
  let notifications = 0;
  const unsubscribe = setting.subscribe(() => {
    notifications += 1;
  });
  const versionBefore = setting.getVersion();
  assert.equal(setting.load(), null);
  assert.equal(
    setting.save("https://git.example.com/org/repo"),
    "https://git.example.com/org/repo",
  );
  assert.equal(setting.getVersion(), versionBefore + 1);
  assert.equal(notifications, 1);
  // 非法输入不落库也不通知，避免侧边栏无意义重渲染。
  assert.equal(setting.save("javascript:alert(1)"), null);
  assert.equal(notifications, 1);
  setting.clear();
  assert.equal(setting.load(), null);
  assert.equal(setting.getVersion(), versionBefore + 2);
  assert.equal(notifications, 2);
  unsubscribe();
  setting.save("https://git.example.com/other");
  assert.equal(notifications, 2);
});

test("normalizeExternalHttpUrl：仅接受 http(s) 完整地址", () => {
  assert.equal(
    normalizeExternalHttpUrl("https://github.com/org/repo"),
    "https://github.com/org/repo",
  );
  assert.equal(
    normalizeExternalHttpUrl("http://localhost:3000/repo"),
    "http://localhost:3000/repo",
  );
  assert.equal(normalizeExternalHttpUrl("ftp://github.com"), null);
  assert.equal(normalizeExternalHttpUrl("github.com/org/repo"), null);
});
