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
  upsertLocalAssistMachine,
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
  saveStoredAssistCode("12345678");
  assert.equal(loadStoredAssistCode(), "12345678");
  // 分组格式归一化后等价入库；纯乱码不入库、保留旧值。
  saveStoredAssistCode("1234-5678-9012-3456");
  assert.equal(loadStoredAssistCode(), "12345678");
  saveStoredAssistCode("not-a-code");
  assert.equal(loadStoredAssistCode(), "12345678");
  clearStoredAssistCode();
  assert.equal(loadStoredAssistCode(), null);
});

test("活动码：多个带码链接以后传入的为准（last-write-wins）", () => {
  saveStoredAssistCode("11111111");
  saveStoredAssistCode("22222222");
  assert.equal(loadStoredAssistCode(), "22222222");
});

test("登记：新码默认名 = <码>的ZCode；重复登记保留原名称", () => {
  assert.deepEqual(loadAssistMachines(), []);
  const created = upsertAssistMachine("12345678");
  assert.equal(created?.name, "12345678的ZCode");
  renameAssistMachine("12345678", "家里的电脑");
  const kept = upsertAssistMachine("12345678");
  assert.equal(kept?.name, "家里的电脑");
  assert.equal(loadAssistMachines().length, 1);
  assert.equal(upsertAssistMachine("bad-input"), null);
});

test("改名：空白名回退为默认名；未知码静默忽略", () => {
  upsertAssistMachine("12345678");
  renameAssistMachine("12345678", "   ");
  assert.equal(loadAssistMachines()[0]?.name, "12345678的ZCode");
  renameAssistMachine("99999999", "不存在");
  assert.equal(loadAssistMachines().length, 1);
});

test("轮换替换：旧码条目换成新码并保留名称与顺序", () => {
  upsertAssistMachine("11111111");
  upsertAssistMachine("22222222");
  renameAssistMachine("11111111", "本机");
  const machines = replaceAssistMachineCode("11111111", "33333333");
  assert.deepEqual(
    machines.map((machine) => [machine.code, machine.name]),
    [
      ["33333333", "本机"],
      ["22222222", "22222222的ZCode"],
    ],
  );
});

test("轮换替换：旧码未登记时兜底登记新码", () => {
  const machines = replaceAssistMachineCode("11111111", "33333333");
  assert.equal(machines.length, 1);
  assert.equal(machines[0]?.code, "33333333");
});

test("删除：移除指定条目，不影响其他条目与活动码", () => {
  upsertAssistMachine("11111111");
  upsertAssistMachine("22222222");
  saveStoredAssistCode("11111111");
  const machines = removeAssistMachine("11111111");
  assert.deepEqual(
    machines.map((machine) => machine.code),
    ["22222222"],
  );
  // 活动码独立存储，删除列表条目不改写它。
  assert.equal(loadStoredAssistCode(), "11111111");
  removeAssistMachine("99999999");
  removeAssistMachine("bad-input");
  assert.equal(loadAssistMachines().length, 1);
});

test("登记默认名：传入 defaultName 生效；仅升级未被改过名的码默认名", () => {
  // 新码直接用传入的默认名（本机 = 我的ZCode）。
  const created = upsertAssistMachine("11111111", "我的ZCode");
  assert.equal(created?.name, "我的ZCode");
  // 旧默认名（<码>的ZCode）视为未改名，升级为新默认名。
  upsertAssistMachine("22222222");
  const upgraded = upsertAssistMachine("22222222", "我的ZCode");
  assert.equal(upgraded?.name, "我的ZCode");
  // 用户改过名的条目不覆盖。
  renameAssistMachine("11111111", "客厅的电脑");
  const kept = upsertAssistMachine("11111111", "我的ZCode");
  assert.equal(kept?.name, "客厅的电脑");
});

test("本机登记：首登打 local 标记并用默认名；同码重复登记不新增", () => {
  const created = upsertLocalAssistMachine("11111111", "我的ZCode");
  assert.equal(created?.local, true);
  assert.equal(created?.name, "我的ZCode");
  assert.equal(loadAssistMachines().length, 1);
  const again = upsertLocalAssistMachine("11111111", "我的ZCode");
  assert.equal(again?.code, "11111111");
  assert.equal(again?.local, true);
  assert.equal(loadAssistMachines().length, 1);
});

test("本机换码合并：新本机码并入 local 条目原位替换，远程条目不受影响", () => {
  // 场景：本机在别的浏览器刷新过码，本浏览器列表里留着旧本机条目 + 一个远程机器。
  upsertLocalAssistMachine("11111111", "我的ZCode");
  upsertAssistMachine("22222222");
  renameAssistMachine("22222222", "可乐的MacMini");
  const merged = upsertLocalAssistMachine("33333333", "我的ZCode");
  assert.equal(merged?.code, "33333333");
  assert.deepEqual(loadAssistMachines(), [
    // 原位替换：名称、登记顺序保持，不新增「我的ZCode」行。
    { code: "33333333", name: "我的ZCode", local: true },
    { code: "22222222", name: "可乐的MacMini" },
  ]);
});

test("本机换码合并：缺省名跟随新码；用户改过名则保留", () => {
  upsertLocalAssistMachine("11111111");
  const renamed = upsertLocalAssistMachine("33333333", "我的ZCode");
  // 旧条目还挂着未改过的码缺省名 → 视为未改名，跟随新码升级为默认本机名。
  assert.equal(renamed?.name, "我的ZCode");
  renameAssistMachine("33333333", "客厅的电脑");
  const kept = upsertLocalAssistMachine("44444444", "我的ZCode");
  assert.equal(kept?.name, "客厅的电脑");
});

test("普通登记不打标记也不清除已有本机标记（打开链接 ≠ 本机）", () => {
  upsertLocalAssistMachine("11111111", "我的ZCode");
  // 打开本机自己的分享链接：已有条目保留标记，不新增。
  const self = upsertAssistMachine("11111111");
  assert.equal(self?.local, true);
  assert.equal(loadAssistMachines().length, 1);
  // 登记远程机器：无 local 标记。
  const remote = upsertAssistMachine("22222222");
  assert.equal(remote?.local, undefined);
});

test("本机标记唯一化：多条 local 的脏数据在下次本机登记时自愈", () => {
  storage.set(
    "zcode-assist-machines",
    JSON.stringify([
      { code: "11111111", name: "甲", local: true },
      { code: "22222222", name: "乙", local: true },
    ]),
  );
  const merged = upsertLocalAssistMachine("33333333", "我的ZCode");
  assert.equal(merged?.code, "33333333");
  assert.deepEqual(loadAssistMachines(), [
    { code: "33333333", name: "甲", local: true },
    { code: "22222222", name: "乙" },
  ]);
});

test("local 标记持久化：非法值忽略，true 落盘后可读回", () => {
  storage.set(
    "zcode-assist-machines",
    JSON.stringify([
      { code: "11111111", name: "甲", local: "yes" },
      { code: "22222222", name: "乙", local: true },
    ]),
  );
  assert.deepEqual(loadAssistMachines(), [
    { code: "11111111", name: "甲" },
    { code: "22222222", name: "乙", local: true },
  ]);
  // 读写 roundtrip 后标记仍在。
  assert.equal(loadAssistMachines()[1]?.local, true);
});

test("轮换替换：替换后的条目保持本机标记", () => {
  upsertLocalAssistMachine("11111111", "我的ZCode");
  const machines = replaceAssistMachineCode("11111111", "33333333");
  assert.equal(machines[0]?.local, true);
  assert.equal(machines[0]?.name, "我的ZCode");
});

test("轮换替换：旧码未登记时兜底按本机登记新码", () => {
  const machines = replaceAssistMachineCode("11111111", "33333333");
  assert.equal(machines.length, 1);
  assert.equal(machines[0]?.code, "33333333");
  assert.equal(machines[0]?.local, true);
});
