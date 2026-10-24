// 表清单注入（data_source_schema reminder）的验收：
// - 绑定首次出现注入一次，绑定不变幂等跳过，切换绑定追加新清单；
// - 去重以 messageHistory 为唯一事实源（扫描最近一条附件的 data-source-id），
//   rewind/恢复重建历史后无需复位任何状态；
// - 快照未同步/数据源不存在时静默跳过（注入是优化项，不制造第二条错误路径）；
// - drain 路径同步追加到进行中轮的请求条目。
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageHistoryImpl } from "../../src/agent/message-history.js";
import type { RuntimeAttachmentEntry } from "../../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import type { TurnRequestState } from "../../src/runtime/methods/turn-loop-state.js";
import {
  buildDataSourceSchemaReminderBody,
  extractDataSourceIdFromReminder,
  injectDataSourceSchemaReminder,
} from "../../src/runtime/methods/data-source-schema-reminder.js";
import {
  SYSTEM_REMINDER_SOURCES,
  wrapSystemReminderForSource,
} from "../../src/system-reminder/source.js";

const ENV_KEY = "ZCODE_DATA_BASE_DIR";

function createRuntimeStub(): AgentRuntimeInternal {
  // persistRuntimeReminderMessage 在 sessionStore 缺席时直接返回，其余字段
  // 只有 messageHistory / logger 会触达。
  return {
    logger: undefined,
    messageHistory: new MessageHistoryImpl(),
    sessionStore: undefined,
  } as unknown as AgentRuntimeInternal;
}

const TRACE = { traceId: "test-trace" } as AgentRuntimeInternal["rootTraceContext"];

async function seedDataSources(
  sources: Array<{ id: string; name: string; readOnly?: boolean }>,
  options: { schemaFor?: string[] } = {},
): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-schema-reminder-"));
  const dir = join(baseDir, ".zcode", "v2", "data-sources");
  await mkdir(join(dir, "schema-cache"), { recursive: true });
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      activeId: null,
      dataSources: sources.map((item) => ({
        createdAt: "2026-01-01T00:00:00.000Z",
        database: "db",
        host: "127.0.0.1",
        id: item.id,
        name: item.name,
        password: "",
        port: 3306,
        readOnly: item.readOnly ?? true,
        type: "mysql",
        user: "root",
      })),
    }),
    "utf-8",
  );
  for (const id of options.schemaFor ?? []) {
    await writeFile(
      join(dir, "schema-cache", `${id}.json`),
      JSON.stringify({
        version: 2,
        fetchedAt: "2026-10-23T09:23:20.893Z",
        tables: [
          { kind: "table", name: "wms_inbound_order", comment: "入库单主表" },
          { kind: "table", name: "wms_warehouse", comment: "仓库表" },
          { kind: "table", name: "sys_plain" },
        ],
      }),
      "utf-8",
    );
  }
  return baseDir;
}

function attachmentsOf(runtime: AgentRuntimeInternal): RuntimeAttachmentEntry[] {
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .filter((entry): entry is RuntimeAttachmentEntry => entry.kind === "attachment");
}

test("绑定首次出现时注入表清单：含 data-source-id、表行与按需查列指引", async () => {
  const baseDir = await seedDataSources(
    [
      { id: "ds-a", name: "生产数据库" },
      { id: "ds-b", name: "测试数据库" },
    ],
    { schemaFor: ["ds-a"] },
  );
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  const runtime = createRuntimeStub();
  try {
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE);
    const attachments = attachmentsOf(runtime);
    assert.equal(attachments.length, 1);
    const content = attachments[0]!.content;
    assert.ok(content.includes("data-source-id: ds-a"));
    assert.ok(content.includes('"生产数据库" (mysql, read-only)'));
    assert.ok(content.includes("wms_inbound_order [table] 入库单主表"));
    // 无注释表不悬挂空尾注
    assert.ok(content.includes("sys_plain [table]"));
    assert.ok(!content.includes("sys_plain [table] \n"));
    assert.ok(content.includes("table=<name>"));
    // canonical 存裸正文，<system-reminder> 包裹由请求渲染层统一做
    assert.ok(!content.includes("<system-reminder>"));
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("同一绑定重复注入幂等跳过；切换绑定追加新清单且保留旧条目", async () => {
  const baseDir = await seedDataSources(
    [
      { id: "ds-a", name: "生产数据库" },
      { id: "ds-b", name: "测试数据库" },
    ],
    { schemaFor: ["ds-a", "ds-b"] },
  );
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  const runtime = createRuntimeStub();
  try {
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE);
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE);
    let attachments = attachmentsOf(runtime);
    assert.equal(attachments.length, 1);

    await injectDataSourceSchemaReminder(runtime, "ds-b", TRACE);
    attachments = attachmentsOf(runtime);
    assert.equal(attachments.length, 2);
    assert.ok(attachments[0]!.content.includes("data-source-id: ds-a"));
    assert.ok(attachments[1]!.content.includes("data-source-id: ds-b"));
    // 再切回 ds-a：内容与首条重复属预期（历史事实保留，最新一条代表当前绑定）
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE);
    assert.equal(attachmentsOf(runtime).length, 3);
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("快照未同步时跳过且不注入；数据源不存在或绑定缺失同样 no-op", async () => {
  const baseDir = await seedDataSources([{ id: "ds-a", name: "生产数据库" }], {
    schemaFor: [],
  });
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  const runtime = createRuntimeStub();
  try {
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE);
    assert.equal(attachmentsOf(runtime).length, 0);
    await injectDataSourceSchemaReminder(runtime, "ds-gone", TRACE);
    assert.equal(attachmentsOf(runtime).length, 0);
    await injectDataSourceSchemaReminder(runtime, undefined, TRACE);
    assert.equal(attachmentsOf(runtime).length, 0);
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("drain 路径：注入同时追加到进行中轮的请求条目", async () => {
  const baseDir = await seedDataSources([{ id: "ds-a", name: "生产数据库" }], {
    schemaFor: ["ds-a"],
  });
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  const runtime = createRuntimeStub();
  const turnRequestState: TurnRequestState = {
    entries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    outputTokenContinuationCount: 0,
  };
  try {
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE, turnRequestState);
    assert.equal(turnRequestState.entries.length, 1);
    assert.ok(turnRequestState.entries[0]!.kind === "attachment");
    // 无 turnRequestState 的 turn 开始路径不追加（快照在注入后创建）
    await injectDataSourceSchemaReminder(runtime, "ds-a", TRACE);
    assert.equal(turnRequestState.entries.length, 1);
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("正文构建：超上限截断提示；id 标记行可逆向解析", () => {
  const tables = Array.from({ length: 160 }, (_, index) => ({
    kind: "table",
    name: `t_${index}`,
    comment: `表${index}`,
  }));
  const body = buildDataSourceSchemaReminderBody({
    dataSourceId: "ds-x",
    fetchedAt: "2026-10-23T09:23:20.893Z",
    readOnly: false,
    sourceName: "宽库",
    sourceType: "postgresql",
    tables,
  });
  assert.ok(body.includes("t_149"));
  assert.ok(!body.includes("t_150"));
  assert.ok(body.includes("10 more tables not listed"));
  assert.ok(body.includes("read-write"));
  assert.equal(extractDataSourceIdFromReminder(body), "ds-x");
});

test("源注册：data_source_schema 在已知源列表且可正常包裹", () => {
  assert.ok(SYSTEM_REMINDER_SOURCES.includes("data_source_schema"));
  const wrapped = wrapSystemReminderForSource(
    "data_source_schema",
    "The data source for this conversation is now X.",
  );
  assert.ok(wrapped.startsWith("<system-reminder>"));
  assert.ok(wrapped.endsWith("</system-reminder>"));
});
