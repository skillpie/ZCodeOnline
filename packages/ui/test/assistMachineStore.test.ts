import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearStoredAssistCode,
  loadAssistMachines,
  loadStoredAssistCode,
  removeAssistMachine,
  renameAssistMachine,
  replaceAssistMachineCode,
  saveStoredAssistCode,
  upsertAssistMachine,
} from "../src/assistMachineStore.js";

// 远程码浏览器存储（specs/web-tunnel.md §5.9）：活动码后到优先、机器列表登记/改名/
// 轮换替换的收口语义。node:test 无 localStorage，用内存实现替换。

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

test("活动码：存取/清空 roundtrip 与非法输入忽略", () => {
  assert.equal(loadStoredAssistCode(), null);
  saveStoredAssistCode("1234567890123456");
  assert.equal(loadStoredAssistCode(), "1234567890123456");
  // 分组格式归一化后等价入库；纯乱码不入库、保留旧值。
  saveStoredAssistCode("1234-5678-9012-3456");
  assert.equal(loadStoredAssistCode(), "1234567890123456");
  saveStoredAssistCode("not-a-code");
  assert.equal(loadStoredAssistCode(), "1234567890123456");
  clearStoredAssistCode();
  assert.equal(loadStoredAssistCode(), null);
});

test("活动码：多个带码链接以后传入的为准（last-write-wins）", () => {
  saveStoredAssistCode("1111111111111111");
  saveStoredAssistCode("2222222222222222");
  assert.equal(loadStoredAssistCode(), "2222222222222222");
});

test("登记：新码默认名 = <码>的ZCode；重复登记保留原名称", () => {
  assert.deepEqual(loadAssistMachines(), []);
  const created = upsertAssistMachine("1234567890123456");
  assert.equal(created?.name, "1234567890123456的ZCode");
  renameAssistMachine("1234567890123456", "家里的电脑");
  const kept = upsertAssistMachine("1234567890123456");
  assert.equal(kept?.name, "家里的电脑");
  assert.equal(loadAssistMachines().length, 1);
  assert.equal(upsertAssistMachine("bad-input"), null);
});

test("改名：空白名回退为默认名；未知码静默忽略", () => {
  upsertAssistMachine("1234567890123456");
  renameAssistMachine("1234567890123456", "   ");
  assert.equal(loadAssistMachines()[0]?.name, "1234567890123456的ZCode");
  renameAssistMachine("9999999999999999", "不存在");
  assert.equal(loadAssistMachines().length, 1);
});

test("轮换替换：旧码条目换成新码并保留名称与顺序", () => {
  upsertAssistMachine("1111111111111111");
  upsertAssistMachine("2222222222222222");
  renameAssistMachine("1111111111111111", "本机");
  const machines = replaceAssistMachineCode("1111111111111111", "3333333333333333");
  assert.deepEqual(
    machines.map((machine) => [machine.code, machine.name]),
    [
      ["3333333333333333", "本机"],
      ["2222222222222222", "2222222222222222的ZCode"],
    ],
  );
});

test("轮换替换：旧码未登记时兜底登记新码", () => {
  const machines = replaceAssistMachineCode("1111111111111111", "3333333333333333");
  assert.equal(machines.length, 1);
  assert.equal(machines[0]?.code, "3333333333333333");
});

test("删除：移除指定条目，不影响其他条目与活动码", () => {
  upsertAssistMachine("1111111111111111");
  upsertAssistMachine("2222222222222222");
  saveStoredAssistCode("1111111111111111");
  const machines = removeAssistMachine("1111111111111111");
  assert.deepEqual(
    machines.map((machine) => machine.code),
    ["2222222222222222"],
  );
  // 活动码独立存储，删除列表条目不改写它。
  assert.equal(loadStoredAssistCode(), "1111111111111111");
  removeAssistMachine("9999999999999999");
  removeAssistMachine("bad-input");
  assert.equal(loadAssistMachines().length, 1);
});

test("登记默认名：传入 defaultName 生效；仅升级未被改过名的码默认名", () => {
  // 新码直接用传入的默认名（本机 = 我的ZCode）。
  const created = upsertAssistMachine("1111111111111111", "我的ZCode");
  assert.equal(created?.name, "我的ZCode");
  // 旧默认名（<码>的ZCode）视为未改名，升级为新默认名。
  upsertAssistMachine("2222222222222222");
  const upgraded = upsertAssistMachine("2222222222222222", "我的ZCode");
  assert.equal(upgraded?.name, "我的ZCode");
  // 用户改过名的条目不覆盖。
  renameAssistMachine("1111111111111111", "客厅的电脑");
  const kept = upsertAssistMachine("1111111111111111", "我的ZCode");
  assert.equal(kept?.name, "客厅的电脑");
});
