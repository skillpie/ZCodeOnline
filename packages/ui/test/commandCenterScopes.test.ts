import assert from "node:assert/strict";
import test from "node:test";
import { resolveQueryScope, scopeToPrefix } from "../src/command-center/commandCenterScopes.js";

test("every scoped history entry maps to a stable search prefix", () => {
  assert.equal(scopeToPrefix("commands"), ">");
  assert.equal(scopeToPrefix("conversations"), "#");
  assert.equal(scopeToPrefix("files"), "@");
  assert.equal(scopeToPrefix("contents"), "$");
  assert.equal(scopeToPrefix("all"), "");
});

test("prefix queries resolve to their explicit scope with the prefix stripped", () => {
  for (const [rawQuery, scope] of [
    [">deploy", "commands"],
    ["#登录失败", "conversations"],
    ["@README", "files"],
    ["$TODO fix", "contents"],
  ] as const) {
    const resolved = resolveQueryScope(rawQuery);
    assert.equal(resolved.scope, scope, rawQuery);
    assert.equal(resolved.explicitScope, true, rawQuery);
    assert.equal(resolved.query, rawQuery.slice(1).trim(), rawQuery);
  }
});

test("plain queries stay in the all scope", () => {
  const resolved = resolveQueryScope("  hello world  ");
  assert.deepEqual(resolved, {
    query: "hello world",
    scope: "all",
    explicitScope: false,
  });
});

test("a lone content prefix yields an empty query in the contents scope", () => {
  const resolved = resolveQueryScope("$");
  assert.equal(resolved.scope, "contents");
  assert.equal(resolved.explicitScope, true);
  assert.equal(resolved.query, "");
});
