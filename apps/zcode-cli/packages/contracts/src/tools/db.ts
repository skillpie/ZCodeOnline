// ============================================================
// DB Tools - Data source query / schema / execute tools
// ============================================================
// 附加式新功能：把「数据源管理」（specs/data-source.md）的只读查询、
// 表结构检索与受控写执行暴露为 Agent 内置工具。
// 数据源配置与表结构缓存由桌面/Web host 写在
// {ZCODE_DATA_BASE_DIR ?? homedir()}/.zcode/v2/data-sources/ 下，agent 侧只读。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Shared pieces
// -----------------------------------------------

export const DB_QUERY_TOOL_NAME = "DBQuery";
export const DB_SCHEMA_TOOL_NAME = "DBSchema";
export const DB_EXECUTE_TOOL_NAME = "DBExecute";

const DB_TARGET_DESCRIPTION =
  "Data source name or id, matching the Data Source panel in the app (case-sensitive). " +
  "Omit to use the currently active data source.";

const DbTargetViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["mysql", "postgresql"]),
    read_only: z.boolean(),
  })
  .strict();

export type DbTargetView = z.infer<typeof DbTargetViewSchema>;

const DbStatementResultSchema = z
  .object({
    sql: z.string(),
    ok: z.boolean(),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    row_count: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    affected: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
    ms: z.number().int().nonnegative(),
  })
  .strict();

export type DbStatementResult = z.infer<typeof DbStatementResultSchema>;

const DbRunOutputShape = {
  data_source: DbTargetViewSchema,
  results: z.array(DbStatementResultSchema),
  duration_ms: z.number().int().nonnegative(),
} as const;

// -----------------------------------------------
// DBQuery —— read-only SQL
// -----------------------------------------------

export const DbQueryInputSchema = z.object({
  data_source: z.string().optional().describe(DB_TARGET_DESCRIPTION),
  sql: z
    .string()
    .min(1)
    .describe(
      "Read-only SQL. Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN statements are allowed; " +
        "separate multiple statements with semicolons. Always add LIMIT to large tables.",
    ),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max rows returned per statement. Default 50, hard cap 200."),
});

export type DbQueryInput = z.infer<typeof DbQueryInputSchema>;

export const DbQueryInputJsonSchema = toToolJsonSchema(DbQueryInputSchema);

export const DbQueryOutputSchema = z.object(DbRunOutputShape).strict();

export type DbQueryOutput = z.infer<typeof DbQueryOutputSchema>;

export const DbQueryOutputJsonSchema = toToolJsonSchema(DbQueryOutputSchema);

// -----------------------------------------------
// DBExecute —— write SQL on read-write sources
// -----------------------------------------------

export const DbExecuteInputSchema = z.object({
  data_source: z.string().optional().describe(DB_TARGET_DESCRIPTION),
  sql: z
    .string()
    .min(1)
    .describe(
      "Write SQL (INSERT / UPDATE / DELETE / DDL). Multiple statements run in one transaction: " +
        "any failure rolls the whole batch back. UPDATE / DELETE must carry a WHERE clause.",
    ),
});

export type DbExecuteInput = z.infer<typeof DbExecuteInputSchema>;

export const DbExecuteInputJsonSchema = toToolJsonSchema(DbExecuteInputSchema);

export const DbExecuteOutputSchema = z.object(DbRunOutputShape).strict();

export type DbExecuteOutput = z.infer<typeof DbExecuteOutputSchema>;

export const DbExecuteOutputJsonSchema = toToolJsonSchema(DbExecuteOutputSchema);

// -----------------------------------------------
// DBSchema —— data source / table discovery
// -----------------------------------------------

export const DbSchemaInputSchema = z.object({
  data_source: z.string().optional().describe(DB_TARGET_DESCRIPTION),
  keyword: z
    .string()
    .optional()
    .describe(
      "Filter tables by keyword matched against table name and comment (e.g. 订单, user, kpi). " +
        "Omit keyword and table to list data sources or all tables.",
    ),
  table: z.string().optional().describe("Exact table name; returns its full column list."),
});

export type DbSchemaInput = z.infer<typeof DbSchemaInputSchema>;

export const DbSchemaInputJsonSchema = toToolJsonSchema(DbSchemaInputSchema);

const DbSchemaColumnSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    comment: z.string(),
  })
  .strict();

const DbSchemaTableSchema = z
  .object({
    name: z.string(),
    comment: z.string(),
    kind: z.string(),
    columns: z.array(DbSchemaColumnSchema).optional(),
  })
  .strict();

export type DbSchemaColumn = z.infer<typeof DbSchemaColumnSchema>;

export type DbSchemaTable = z.infer<typeof DbSchemaTableSchema>;

export const DbSchemaOutputSchema = z
  .object({
    data_source: DbTargetViewSchema.nullable(),
    /** null 表示该数据源尚未同步过表结构（请在应用的数据源面板点击同步）。 */
    synced_at: z.string().nullable(),
    table_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    tables: z.array(DbSchemaTableSchema),
  })
  .strict();

export type DbSchemaOutput = z.infer<typeof DbSchemaOutputSchema>;

export const DbSchemaOutputJsonSchema = toToolJsonSchema(DbSchemaOutputSchema);

// -----------------------------------------------
// DBExport —— 表结构 / 数据导出为 SQL 文件
// -----------------------------------------------

export const DB_EXPORT_TOOL_NAME = "DBExport";

export const DbExportInputSchema = z.object({
  data_source: z.string().optional().describe(DB_TARGET_DESCRIPTION),
  scope: z
    .enum(["ddl", "dml"])
    .describe("ddl = table structures (CREATE TABLE); dml = table data (INSERT statements)"),
  tables: z
    .array(z.string())
    .optional()
    .describe(
      "Tables to export. Required for dml. For ddl, omit to export every base table (minus exclude_tables).",
    ),
  exclude_tables: z
    .array(z.string())
    .optional()
    .describe("ddl only: tables to skip. Default excludes schema_migrations."),
  output_dir: z
    .string()
    .optional()
    .describe("Target directory, relative to the working directory (default sql/export) or absolute."),
  max_rows_per_table: z
    .number()
    .int()
    .min(1)
    .max(500_000)
    .optional()
    .describe("dml only: row cap per table (default 50000); truncated beyond that."),
});

export type DbExportInput = z.infer<typeof DbExportInputSchema>;

export const DbExportInputJsonSchema = toToolJsonSchema(DbExportInputSchema);

export const DbExportOutputSchema = z
  .object({
    data_source: DbTargetViewSchema,
    scope: z.enum(["ddl", "dml"]),
    output_dir: z.string(),
    files: z.array(
      z
        .object({
          table: z.string(),
          path: z.string(),
          rows: z.number().int().nonnegative(),
          truncated: z.boolean(),
        })
        .strict(),
    ),
    skipped: z.array(
      z
        .object({
          table: z.string(),
          reason: z.string(),
        })
        .strict(),
    ),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();

export type DbExportOutput = z.infer<typeof DbExportOutputSchema>;

export const DbExportOutputJsonSchema = toToolJsonSchema(DbExportOutputSchema);
