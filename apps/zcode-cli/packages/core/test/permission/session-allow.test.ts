// DBExecute「本会话内始终允许」的判定验收：alwaysAsk 工具的会话免确认链路
// （弹窗 allowSession 选项 → grantSessionPermission → checkAlwaysAsk 命中
// sessionRules 放行），以及阻断分支仍然压过会话规则的边界。
import test from "node:test";
import assert from "node:assert/strict";
import {
  PermissionService,
  defaultPermissionConfig,
  type PermissionContext,
  type PermissionToolCapability,
} from "../../src/permission/service.js";

const dbExecuteCapability: PermissionToolCapability = {
  alwaysAsk: true,
  readOnly: false,
  destructive: true,
  riskLevel: "high",
  needsApproval: true,
  sideEffectScope: "network",
};

function dbExecuteContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    toolName: "DBExecute",
    input: { sql: "COMMENT ON TABLE \"user\" IS 'user table'", data_source: "pg-main" },
    riskLevel: "high",
    mode: "build",
    ...overrides,
  };
}

function grant(toolName: string) {
  return [{ type: "addRules" as const, behavior: "allow" as const, rules: [{ toolName }] }];
}

test("alwaysAsk tool asks before any session grant", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(dbExecuteContext(), dbExecuteCapability);

  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "tool.alwaysAsk");
  assert.equal(decision.alwaysAsk, true);
});

test("session grant lets the alwaysAsk tool through without asking again", () => {
  const service = new PermissionService();
  service.grantSessionPermission(grant("DBExecute"));
  const decision = service.checkPermission(dbExecuteContext(), dbExecuteCapability);

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "rule.session.allow");
});

test("session allow is mode-agnostic: plan mode does not re-ask a granted tool", () => {
  const service = new PermissionService();
  service.grantSessionPermission(grant("DBExecute"));
  const decision = service.checkPermission(dbExecuteContext({ mode: "plan", planEnabled: true }), dbExecuteCapability);

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "rule.session.allow");
});

test("session grant is tool-scoped: other tools keep asking", () => {
  const service = new PermissionService();
  service.grantSessionPermission(grant("DBQuery"));
  const decision = service.checkPermission(dbExecuteContext(), dbExecuteCapability);

  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "tool.alwaysAsk");
});

test("disallowedTools still denies after a session grant", () => {
  const service = new PermissionService({
    ...defaultPermissionConfig,
    disallowedTools: new Set(["DBExecute"]),
  });
  service.grantSessionPermission(grant("DBExecute"));
  const decision = service.checkPermission(dbExecuteContext(), dbExecuteCapability);

  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("project deny rule still beats the session grant", () => {
  const service = new PermissionService();
  service.grantSessionPermission(grant("DBExecute"));
  const decision = service.checkPermission(dbExecuteContext(), dbExecuteCapability, {
    version: 1,
    deny: [{ toolName: "DBExecute" }],
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.project.deny");
});
