// DBQuery 行数上限（硬上限 1000，默认 50）与模型可见渲染的验收：
// - max_rows 入参契约：1–1000 合法，超过 1000 被 schema 拒绝；
// - 缺省 50、显式 1000 如实透传给 driver 的 executeBatch（clamp 仅兜底）；
// - formatDbRunModelContent 不做二次 50 行截断：rows 是 driver 按 max_rows
//   截断后的结果，渲染必须全量可见，否则调高上限对模型不可见（回归防护）。
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";

vi.mock("../../src/tool/handlers/db/store.js", () => ({
  resolveDataSource: vi.fn(),
}));
vi.mock("../../src/tool/handlers/db/driver.js", () => ({
  executeBatch: vi.fn(),
}));

import { DbQueryInputSchema } from "@zcode/contracts";
import { dbQueryToolEntry, formatDbRunModelContent } from "../../src/tool/handlers/db/db-query.js";
import { resolveDataSource } from "../../src/tool/handlers/db/store.js";
import { executeBatch } from "../../src/tool/handlers/db/driver.js";

const resolveDataSourceMock = vi.mocked(resolveDataSource);
const executeBatchMock = vi.mocked(executeBatch);

beforeEach(() => {
  vi.resetAllMocks();
});

function fakeSource() {
  return {
    id: "ds-a",
    name: "生产数据库",
    config: { type: "mysql" as const, host: "127.0.0.1", port: 3306, user: "root", password: "" },
    read_only: true,
  } as Awaited<ReturnType<typeof resolveDataSource>>;
}

function queryOutput(rows: Record<string, unknown>[], rowCount: number, truncated: boolean) {
  return {
    data_source: { id: "ds-a", name: "生产数据库", type: "mysql" as const, read_only: true },
    results: [
      { sql: "SELECT id FROM t", ok: true, columns: ["id"], rows, row_count: rowCount, truncated, ms: 5 },
    ],
    duration_ms: 6,
  } as Awaited<ReturnType<typeof executeBatch>>;
}

const handlerContext = { dataSourceId: undefined } as unknown as Parameters<
  (typeof dbQueryToolEntry)["handler"]
>[1];

test("max_rows 契约：1000 合法，1001 被拒绝，可缺省", () => {
  assert.equal(DbQueryInputSchema.safeParse({ sql: "SELECT 1", max_rows: 1000 }).success, true);
  assert.equal(DbQueryInputSchema.safeParse({ sql: "SELECT 1", max_rows: 1001 }).success, false);
  assert.equal(DbQueryInputSchema.safeParse({ sql: "SELECT 1" }).success, true);
});

test("缺省透传 50 行、显式 1000 行透传给 executeBatch", async () => {
  resolveDataSourceMock.mockResolvedValue(fakeSource());
  executeBatchMock.mockResolvedValue(queryOutput([{ id: 1 }], 1, false));

  await dbQueryToolEntry.handler({ sql: "SELECT id FROM t" }, handlerContext);
  assert.equal(executeBatchMock.mock.calls[0]?.[2]?.maxRows, 50);

  executeBatchMock.mockClear();
  await dbQueryToolEntry.handler({ sql: "SELECT id FROM t", max_rows: 1000 }, handlerContext);
  assert.equal(executeBatchMock.mock.calls[0]?.[2]?.maxRows, 1000);
});

test("渲染层不再二次截 50 行：超限提示与实际渲染一致", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ id: index }));
  const content = formatDbRunModelContent(queryOutput(rows, 1200, true));
  assert.ok(content.includes("1200 rows"));
  assert.ok(content.includes("\n  999")); // 最后一行（id=999）可见
  assert.ok(!content.includes("\n  1000")); // driver 截断外的行不出现
  assert.ok(content.includes("showing 1000 of 1200 rows"));
});

test("未超限时全部行渲染且无截断提示", () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ id: index }));
  const content = formatDbRunModelContent(queryOutput(rows, 150, false));
  assert.ok(content.includes("150 rows"));
  assert.ok(content.includes("\n  149"));
  assert.ok(!content.includes("truncated"));
});
