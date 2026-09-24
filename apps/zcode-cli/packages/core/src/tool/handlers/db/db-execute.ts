// ============================================================
// DBExecute Tool Handler — write SQL with mandatory approval
// ============================================================
// 权限设计：写语句对数据库是有真实副作用的操作，声明 alwaysAsk，
// 任何权限模式（含 yolo / plan 直通）都必须先经用户确认；且目标数据
// 源必须是读写模式（只读数据源在 handler 层直接拒绝，不给确认机会）。
// 批内语句统一包事务：任一失败整批回滚（见 driver.executeBatch）。

import {
  DB_EXECUTE_TOOL_NAME,
  DbExecuteInputJsonSchema,
  DbExecuteInputSchema,
  DbExecuteOutputJsonSchema,
  DbExecuteOutputSchema,
  type DbExecuteInput,
  type DbExecuteOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../../types.js";
import { resolveDataSource } from "./store.js";
import { executeBatch } from "./driver.js";
import { formatDbRunModelContent } from "./db-query.js";

const MAX_RESULT_MODEL_BYTES = 40_000;

export const dbExecuteToolDescription =
  "Execute write SQL (INSERT / UPDATE / DELETE / DDL) on a read-write data source. Requires explicit " +
  "user approval for every call and is rejected on read-only data sources. Multiple statements run in " +
  "one transaction: any failure rolls back the whole batch.";

const dbExecuteHandler: ToolHandler = async (input) => {
  const { data_source: target, sql } = DbExecuteInputSchema.parse(input) as DbExecuteInput;
  const source = await resolveDataSource(target);
  if (source.config.readOnly) {
    return {
      data_source: source.view,
      results: [
        {
          sql,
          ok: false,
          error:
            `Data source "${source.view.name}" is in read-only mode; writes are rejected without ` +
            "executing anything. Ask the user to switch it to read-write in the Data Source panel first.",
          ms: 0,
        },
      ],
      duration_ms: 0,
    } satisfies DbExecuteOutput;
  }
  return executeBatch(source, sql, {
    maxRows: 200,
    readOnly: false,
    readOnlyReason: "unreachable: DBExecute only targets read-write sources",
  }) as Promise<DbExecuteOutput>;
};

export const dbExecuteToolEntry: ToolEntry = {
  capability: "Run write SQL inside a transaction on a read-write data source after user approval",
  metadata: {
    name: DB_EXECUTE_TOOL_NAME,
    description: dbExecuteToolDescription,
    modelInstructions: [
      "UPDATE / DELETE must carry a WHERE clause; confirm affected scope with the user for broad changes.",
      "Read-only data sources reject writes here — surface the limitation instead of retrying.",
    ],
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: 65_000,
    maxOutputBytes: MAX_RESULT_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "high",
    needsApproval: true,
  },
  handler: dbExecuteHandler,
  inputSchema: DbExecuteInputJsonSchema,
  outputSchema: DbExecuteOutputJsonSchema,
  runtimeInputSchema: DbExecuteInputSchema,
  runtimeOutputSchema: DbExecuteOutputSchema,
  // 与 DBQuery 同一套紧凑文本渲染（查询/受影响行数两种结果形态都覆盖）
  formatModelContent: formatDbRunModelContent,
  permission: {
    permission: "dbExecute",
    reason: "DBExecute writes to the database; every call needs explicit user approval",
    riskLevel: "high",
    sideEffectScope: "network",
    needsApproval: true,
    patternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 每次调用写入的 SQL 都不同，「批准过一次」推不出「下次也批准」；
    // 持久免确认永不开放，会话级也不开放（生产库写入必须次次确认）。
    alwaysAsk: true,
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: MAX_RESULT_MODEL_BYTES,
    maxModelBytes: MAX_RESULT_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_RESULT_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 65_000,
    maxMs: 65_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "DBExecute was cancelled; the current transaction was rolled back",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
