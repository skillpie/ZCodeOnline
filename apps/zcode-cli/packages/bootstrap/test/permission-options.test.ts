// 权限选项投影验收：optionsPolicy 决定弹窗里 always-allow 槽位的形态——
// session-always-allow 投出会话选项（response 不带 permissionUpdates，会话语义由
// broker 在应答侧合成）；no-always-allow 裁掉整个槽位；默认投项目级持久规则。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
  buildSessionPermissionUpdates,
  toLegacyPermissionOptionsPolicy,
} from "../src/permission-options.js";

const dbExecuteSource = {
  input: { sql: "UPDATE \"user\" SET name = 'x'", data_source: "pg-main" },
  toolName: "DBExecute",
};

test("session-always-allow projects a session option without persistent updates", () => {
  const options = buildProtocolPermissionOptions({
    ...dbExecuteSource,
    optionsPolicy: "session-always-allow",
  });

  assert.deepEqual(
    options.map((option) => option.kind),
    ["allow_once", SESSION_ALLOW_PERMISSION_OPTION_KIND, "deny"],
  );
  const sessionOption = options[1];
  assert.equal(sessionOption.optionId, "allowSession");
  assert.equal("permissionUpdates" in sessionOption.response, false);
});

test("no-always-allow drops the whole always-allow slot", () => {
  const options = buildProtocolPermissionOptions({
    ...dbExecuteSource,
    optionsPolicy: "no-always-allow",
  });

  assert.deepEqual(
    options.map((option) => option.kind),
    ["allow_once", "deny"],
  );
});

test("default policy projects a project rule option carrying permissionUpdates", () => {
  const options = buildProtocolPermissionOptions(dbExecuteSource);
  const projectOption = options.find((option) => option.kind === "allow_always");

  assert.ok(projectOption);
  assert.equal(projectOption.optionId, "allow_project");
  assert.ok(projectOption.response.permissionUpdates?.length);
});

test("session grants are tool-wide: rule without ruleContent", () => {
  assert.deepEqual(buildSessionPermissionUpdates("DBExecute"), [
    { type: "addRules", behavior: "allow", rules: [{ toolName: "DBExecute" }] },
  ]);
});

test("legacy v3 clients degrade session policy to no-always-allow", () => {
  assert.equal(toLegacyPermissionOptionsPolicy("session-always-allow"), "no-always-allow");
  assert.equal(toLegacyPermissionOptionsPolicy("no-always-allow"), "no-always-allow");
  assert.equal(toLegacyPermissionOptionsPolicy(undefined), undefined);
});
