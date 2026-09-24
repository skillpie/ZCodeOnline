// ============================================================
// DBSchema Tool Handler — data source & table discovery
// ============================================================
// 只读工具：数据源清单 + 表结构缓存检索（表名/注释/字段）。
// 缓存由桌面/Web host 的「数据源」面板同步落盘；未同步时提示用户去
// 点同步，agent 不做实时内省（保持与 host 侧单一所有者）。

import {
  DB_SCHEMA_TOOL_NAME,
  DbSchemaInputJsonSchema,
  DbSchemaInputSchema,
  DbSchemaOutputJsonSchema,
  DbSchemaOutputSchema,
  type DbSchemaInput,
  type DbSchemaOutput,
  type DbSchemaTable,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../../types.js";
import { readSchemaCache, resolveDataSource } from "./store.js";

const MAX_LISTED_TABLES = 150;
const MAX_LISTED_COLUMNS = 80;
const MAX_RESULT_MODEL_BYTES = 40_000;

export const dbSchemaToolDescription =
  "Discover configured data sources and their table structures (names, comments, columns) from the " +
  "locally synced schema cache. Use it before DBQuery/DBExecute to find exact table and column names.";

const dbSchemaHandler: ToolHandler = async (input) => {
  const { data_source: target, keyword, table } = DbSchemaInputSchema.parse(input) as DbSchemaInput;
  const source = await resolveDataSource(target);
  const cache = await readSchemaCache(source.config.id);
  if (!cache) {
    throw new Error(
      `Data source "${source.view.name}" has no synced schema yet. ` +
        "Ask the user to open the Data Source panel in the app and sync it (it syncs automatically when adding or switching data sources).",
    );
  }

  const filtered = filterTables(cache.tables, keyword, table);
  const output: DbSchemaOutput = {
    data_source: source.view,
    synced_at: cache.fetchedAt,
    table_count: filtered.length,
    truncated: filtered.length > MAX_LISTED_TABLES,
    tables: filtered.slice(0, MAX_LISTED_TABLES).map((item) => ({
      name: item.name,
      comment: item.comment,
      kind: item.kind,
      // 仅精确查表时携带字段清单，列表模式保持轻量
      columns: table ? (item.columns ?? []).slice(0, MAX_LISTED_COLUMNS) : undefined,
    })),
  };
  return output satisfies DbSchemaOutput;
};

function filterTables(tables: DbSchemaTable[], keyword?: string, table?: string): DbSchemaTable[] {
  if (table) {
    const exact = tables.find((item) => item.name === table);
    if (exact) return [exact];
    // 精确名未命中时回退为包含匹配，帮助模型纠正表名
    return tables.filter((item) => item.name.toLowerCase().includes(table.toLowerCase()));
  }
  if (keyword) {
    const needle = keyword.toLowerCase();
    return tables.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) || item.comment.toLowerCase().includes(needle),
    );
  }
  return tables;
}

export const dbSchemaToolEntry: ToolEntry = {
  capability: "List configured data sources and search their synced table structures",
  metadata: {
    name: DB_SCHEMA_TOOL_NAME,
    description: dbSchemaToolDescription,
    modelInstructions: [
      "Call without keyword/table to list all tables; pass keyword (matches table name or Chinese comment) to narrow down; pass table for the exact column list.",
      "Run this before composing SQL so identifiers come from the real schema instead of guesses.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_RESULT_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: dbSchemaHandler,
  inputSchema: DbSchemaInputJsonSchema,
  outputSchema: DbSchemaOutputJsonSchema,
  runtimeInputSchema: DbSchemaInputSchema,
  runtimeOutputSchema: DbSchemaOutputSchema,
  formatModelContent: formatDbSchemaModelContent,
  permission: {
    permission: "read",
    reason: "DBSchema only reads the locally synced schema cache",
    riskLevel: "low",
    sideEffectScope: "none",
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
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "DBSchema was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatDbSchemaModelContent(output: unknown): string {
  const result = output as DbSchemaOutput;
  const source = result.data_source;
  if (!source) return "no data source resolved";
  const header = `data source: ${source.name} (${source.type}${source.read_only ? ", read-only" : ", read-write"}) · schema synced at ${result.synced_at} · ${result.table_count} tables`;
  const lines = result.tables.map((item) => {
    const label = item.comment ? `${item.name} — ${item.comment} [${item.kind}]` : `${item.name} [${item.kind}]`;
    if (!item.columns) return `  ${label}`;
    const columns = item.columns
      .map((column) => `${column.name} ${column.type}${column.comment ? ` ${column.comment}` : ""}`)
      .join("; ");
    return `  ${label}\n    ${columns}`;
  });
  const body = lines.length ? lines.join("\n") : "  (no tables matched)";
  return `${header}\n${body}${result.truncated ? "\n  (table list truncated — use keyword to narrow down)" : ""}`;
}
