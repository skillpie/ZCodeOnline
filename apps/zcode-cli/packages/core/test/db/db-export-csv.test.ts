// DBExport scope=csv 的纯函数验收：RFC 4180 序列化与 where 片段安全校验。
// 不连真实数据库——SQL 拼接在 driver.selectTableRows 内部，网络行为由既有 driver 覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../../src/tool/handlers/db/db-export.js";
import { assertSafeWhereCondition } from "../../src/tool/handlers/db/driver.js";

test("toCsv renders header row and escapes per RFC 4180", () => {
  const csv = toCsv(["id", "name", "note"], [
    [1, "plain", "ok"],
    [2, "a,b", 'say "hi"'],
    [3, "line\nbreak", null],
  ]);
  assert.equal(
    csv,
    [
      "id,name,note",
      "1,plain,ok",
      '2,"a,b","say ""hi"""',
      '3,"line\nbreak",',
      "",
    ].join("\n"),
  );
});

test("toCsv renders NULL as empty, BLOB as hex, JSON column as JSON text", () => {
  const csv = toCsv(["blob", "extra", "count"], [[Buffer.from("AB", "utf-8"), { k: 1 }, null]]);
  assert.equal(csv, `blob,extra,count\n4142,"{""k"":1}",\n`);
});

test("assertSafeWhereCondition trims and keeps plain conditions", () => {
  assert.equal(assertSafeWhereCondition(" status = 'active' "), "status = 'active'");
  // 字面量里的 '--' 与 '#' 不触发注释拦截
  assert.equal(assertSafeWhereCondition("`note` = 'a--b # c'"), "`note` = 'a--b # c'");
  // 值里含分号同样放行（引号内）
  assert.equal(assertSafeWhereCondition("url = 'http://x;a'"), "url = 'http://x;a'");
});

test("assertSafeWhereCondition rejects structural injection and side-effect suffixes", () => {
  const rejects = (where: string, message: RegExp) =>
    assert.throws(() => assertSafeWhereCondition(where), message);
  rejects("", /non-empty/);
  rejects("   ", /non-empty/);
  rejects("a = 1;", /semicolons/);
  rejects("a = 1 -- comment", /semicolons/);
  rejects("/* hint */ a = 1", /semicolons/);
  rejects("a = 1 # tag", /semicolons/);
  rejects("a = '", /unclosed quote/);
  rejects("a = 1 INTO OUTFILE '/tmp/x'", /INTO OUTFILE/);
  rejects("a = 1 FOR UPDATE", /FOR UPDATE/);
  rejects("a = 1 LOCK IN SHARE MODE", /LOCK IN SHARE MODE/);
});
