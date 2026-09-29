import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import {
  clearStoredAssistCode,
  fetchAssistCodeViaDiscovery,
  loadStoredAssistCode,
  refreshAssistCodeViaDiscovery,
  saveStoredAssistCode,
} from "../src/tunnel/assistSession.js";

// 浏览器侧远程码回环发现端点（specs/web-tunnel.md §5.9）：读取/刷新与存储回写。
// 兑换错误归类用例随实现迁至 packages/client/test/assistRedeem.test.ts；
// 存储语义（活动码/机器列表/改名）收口在 @zcode/ui/assist-machine-store，
// 用例见 packages/ui/test/assistMachineStore.test.ts。

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

describe("refreshAssistCodeViaDiscovery", () => {
  const originalFetch = globalThis.fetch;

  test("回环端点不可达 → 抛出可读错误且不改存储", async () => {
    clearStoredAssistCode();
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    try {
      // 文案随 navigator.language 双语，断言两类语言的关键词。
      await assert.rejects(() => refreshAssistCodeViaDiscovery(), /隧道服务|unreachable/);
      assert.equal(loadStoredAssistCode(), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("刷新成功 → 返回新码并覆盖本地存储", async () => {
    saveStoredAssistCode("1111111111111111");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "9999999999999999", expiresAt: 4102444800000 }), {
        status: 200,
      })) as typeof fetch;
    try {
      const refreshed = await refreshAssistCodeViaDiscovery();
      assert.equal(refreshed.code, "9999999999999999");
      assert.equal(loadStoredAssistCode(), "9999999999999999");
    } finally {
      globalThis.fetch = originalFetch;
      clearStoredAssistCode();
    }
  });

  test("读取当前码：返回宿主权威码且不写存储", async () => {
    clearStoredAssistCode();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "8888888888888888", expiresAt: 4102444800000 }), {
        status: 200,
      })) as typeof fetch;
    try {
      const current = await fetchAssistCodeViaDiscovery();
      assert.equal(current.code, "8888888888888888");
      assert.equal(loadStoredAssistCode(), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
