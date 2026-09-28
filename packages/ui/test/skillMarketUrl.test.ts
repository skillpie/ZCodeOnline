import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  DEFAULT_SKILL_MARKET_ENTRY_URL,
  clearStoredSkillMarketUrl,
  loadStoredSkillMarketUrl,
  normalizeSkillMarketUrl,
  resolveSkillMarketEntryUrl,
  resolveTrustedSkillMarketSsoOrigin,
  saveStoredSkillMarketUrl,
} from "../src/skillMarketUrl.js";

// 技能市场链接设置（specs/skill-market.md §1）：存储 roundtrip、非法输入拦截、
// 入口链接解析与免登握手可信 origin 收口。node:test 无 localStorage，用内存实现替换。

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

test("默认入口链接为 https://skillpie.cn/skills（specs/skill-market.md §1）", () => {
  assert.equal(DEFAULT_SKILL_MARKET_ENTRY_URL, "https://skillpie.cn/skills");
  assert.equal(resolveSkillMarketEntryUrl(), "https://skillpie.cn/skills");
});

test("归一化：仅接受 http(s) 完整地址，非法输入返回 null", () => {
  assert.equal(normalizeSkillMarketUrl("https://skillpie.cn/skills"), "https://skillpie.cn/skills");
  assert.equal(normalizeSkillMarketUrl("  https://skillpie.cn  "), "https://skillpie.cn/");
  // 内网自部署允许 http，但 ftp/无协议/乱码不接受。
  assert.equal(
    normalizeSkillMarketUrl("http://192.168.1.10:3000/skills"),
    "http://192.168.1.10:3000/skills",
  );
  assert.equal(normalizeSkillMarketUrl("ftp://skillpie.cn"), null);
  assert.equal(normalizeSkillMarketUrl("skillpie.cn/skills"), null);
  assert.equal(normalizeSkillMarketUrl("not-a-url"), null);
  assert.equal(normalizeSkillMarketUrl("   "), null);
});

test("保存/读取 roundtrip；非法输入不落库并返回 null", () => {
  assert.equal(loadStoredSkillMarketUrl(), null);
  assert.equal(
    saveStoredSkillMarketUrl("https://market.example.com/skills"),
    "https://market.example.com/skills",
  );
  assert.equal(loadStoredSkillMarketUrl(), "https://market.example.com/skills");
  assert.equal(resolveSkillMarketEntryUrl(), "https://market.example.com/skills");
  // 非法输入保留旧值，不产生半写状态。
  assert.equal(saveStoredSkillMarketUrl("javascript:alert(1)"), null);
  assert.equal(loadStoredSkillMarketUrl(), "https://market.example.com/skills");
});

test("清除后回到默认入口链接", () => {
  saveStoredSkillMarketUrl("https://market.example.com/skills");
  clearStoredSkillMarketUrl();
  assert.equal(loadStoredSkillMarketUrl(), null);
  assert.equal(resolveSkillMarketEntryUrl(), "https://skillpie.cn/skills");
});

test("免登握手 origin 收口：默认市场可信，自定义/非法链接禁用握手", () => {
  assert.equal(
    resolveTrustedSkillMarketSsoOrigin("https://skillpie.cn/skills"),
    "https://skillpie.cn",
  );
  assert.equal(
    resolveTrustedSkillMarketSsoOrigin(DEFAULT_SKILL_MARKET_ENTRY_URL),
    "https://skillpie.cn",
  );
  // 运行期可改写的自定义 origin 不发平台 JWT。
  assert.equal(resolveTrustedSkillMarketSsoOrigin("https://market.example.com/skills"), null);
  assert.equal(resolveTrustedSkillMarketSsoOrigin("http://localhost:3001/skills"), null);
  assert.equal(resolveTrustedSkillMarketSsoOrigin("not-a-url"), null);
});
