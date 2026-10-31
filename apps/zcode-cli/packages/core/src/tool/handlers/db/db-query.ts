// ============================================================
// DBQuery Tool Handler — read-only SQL on configured data sources
// ============================================================
// 权限不变量：本工具对权限系统声明 readOnly，因此无论目标数据源是
// 只读还是读写模式，handler 都强制拦截非查询语句（写操作必须走
// DBExecute，它有独立的 alwaysAsk 确认门）。

import {
  DB_QUERY_TOOL_NAME,
  DbQueryInputJsonSchema,
  DbQueryInputSchema,
  DbQueryOutputJsonSchema,
  DbQueryOutputSchema,
  type DbQueryInput,
  type DbQueryOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../../types.js";
import { resolveDataSource } from "./store.js";
import { executeBatch } from "./driver.js";

const DEFAULT_MAX_ROWS = 50;
const HARD_MAX_ROWS = 1000;
const MAX_RESULT_MODEL_BYTES = 60_000;

export const dbQueryToolDescription =
  "Execute read-only SQL (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN) against a configured MySQL or " +
  "PostgreSQL data source. Use DBSchema first to discover data sources, tables and columns; " +
  "always add LIMIT to queries on large tables.";

const dbQueryHandler: ToolHandler = async (input, context) => {
  const { data_source: target, sql, max_rows } = DbQueryInputSchema.parse(input) as DbQueryInput;
  // 缺省目标源优先取会话级选择（specs/data-source.md §7），显式入参仍最优先。
  const source = await resolveDataSource(target, context.dataSourceId);
  const result = await executeBatch(source, sql, {
    maxRows: Math.min(Math.max(max_rows ?? DEFAULT_MAX_ROWS, 1), HARD_MAX_ROWS),
    // 工具级只读不变量：与目标数据源的模式无关，DBQuery 永不放行写语句
    readOnly: true,
    readOnlyReason:
      "DBQuery only allows read-only statements (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN). " +
      "Use DBExecute for writes; it requires user approval and a read-write data source.",
  });
  return result satisfies DbQueryOutput;
};

export const dbQueryToolEntry: ToolEntry = {
  capability: "Query configured MySQL/PostgreSQL data sources with read-only SQL",
  metadata: {
    name: DB_QUERY_TOOL_NAME,
    description: dbQueryToolDescription,
    modelInstructions: [
      "Pick table names from the bound data-source table list in context (or resolve them with DBSchema when absent) before writing SQL; do not guess identifiers.",
      "Load exact column names with DBSchema table=<name> when column details are needed.",
      "Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN are allowed here — writes belong to DBExecute.",
      "Add LIMIT to exploratory detail queries; results are capped at 1000 rows per statement.",
      // 实测（2026-10-24，86 仓聚合案例）：模型先查 information_schema 评量级再聚合、
      // 截断后重跑，各多一次往返。聚合被行数上限保护，无需预查；预期超默认 50 行
      // 的分组（各仓库/各租户/按天）首查就取 max_rows=1000。
      "Aggregations (GROUP BY / counts) are safe to run directly — skip information_schema row-count pre-checks; when the grouping may exceed the default 50 rows (per-warehouse, per-tenant, per-day breakdowns), pass max_rows=1000 on the first call instead of re-querying after truncation.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 65_000,
    maxOutputBytes: MAX_RESULT_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: dbQueryHandler,
  inputSchema: DbQueryInputJsonSchema,
  outputSchema: DbQueryOutputJsonSchema,
  runtimeInputSchema: DbQueryInputSchema,
  runtimeOutputSchema: DbQueryOutputSchema,
  formatModelContent: formatDbRunModelContent,
  permission: {
    permission: "read",
    reason: "DBQuery only runs read-only SQL against the configured data source",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName"],
    denyPriority: "beforeAsk",
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
    userVisibleMessage: "DBQuery was cancelled before the SQL finished",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    // SQL 文本与行数据可能含业务敏感信息，trace 只记摘要
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** 查询/执行共用：把语句结果渲染成紧凑文本，省 token 也降低截断概率。 */
export function formatDbRunModelContent(output: unknown): string {
  const run = output as DbQueryOutput;
  const lines: string[] = [];
  const source = run.data_source;
  lines.push(
    `data source: ${source.name} (${source.type}${source.read_only ? ", read-only" : ", read-write"})`,
  );
  for (const result of run.results) {
    if (!result.ok) {
      lines.push(`[ERROR] ${result.sql}\n  ${result.error ?? "unknown error"}`);
      continue;
    }
    if (result.rows !== undefined) {
      lines.push(...formatRows(result));
    } else {
      lines.push(`[OK] ${result.sql}\n  affected: ${result.affected ?? 0} (${result.ms}ms)`);
    }
  }
  lines.push(`total: ${run.duration_ms}ms`);
  return lines.join("\n");
}

function formatRows(result: {
  sql: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
  truncated?: boolean;
  ms?: number;
}): string[] {
  const rows = result.rows ?? [];
  const columns = result.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [`${result.sql}`, `  ${result.row_count ?? rows.length} rows (${result.ms ?? 0}ms)`];
  if (rows.length === 0) return lines;
  lines.push(`  ${columns.join(" | ")}`);
  // 行数上限由 driver 按 max_rows 截断（rows 即截断后结果），这里不能二次截 50 行，
  // 否则调高 max_rows 上限对模型不可见；超限提示以 row_count 与 rows 长度差为准。
  for (const row of rows) {
    lines.push(
      `  ${columns.map((column) => stringifyCell(row[column])).join(" | ")}`,
    );
  }
  if (result.truncated || (result.row_count ?? 0) > rows.length) {
    lines.push(
      `  (truncated: showing ${rows.length} of ${result.row_count} rows — refine the query or lower LIMIT)`,
    );
  }
  return lines;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
