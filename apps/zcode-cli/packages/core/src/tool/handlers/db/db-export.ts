// ============================================================
// DBExport Tool Handler — DDL / DML / CSV export to files
// ============================================================
// 对齐 db_cli.py 的导出能力（--export-ddl / --export-dml，仅 MySQL），并扩展 CSV：
// - ddl：全部（或指定）基表的 CREATE TABLE 写入单个文件，含 DROP TABLE IF EXISTS
// - dml：逐表 SELECT（LIMIT 封顶）转 INSERT，每表一个文件，空表跳过
// - csv：与 dml 同一取数通道（支持 where 过滤），逐表转 CSV 文件；空结果保留表头
// 文件写入是 workspace 副作用：与 Write 同档声明（needsApproval，可被规则记住放行）。
// 对数据库本身只读，只读模式的数据源也能导出。

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  DB_EXPORT_TOOL_NAME,
  DbExportInputJsonSchema,
  DbExportInputSchema,
  DbExportOutputJsonSchema,
  DbExportOutputSchema,
  type DbExportInput,
  type DbExportOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../../types.js";
import { resolveDataSource } from "./store.js";
import {
  listBaseTables,
  selectTableRows,
  showCreateTable,
  withClient,
  type DriverClient,
} from "./driver.js";

const DEFAULT_OUTPUT_DIR = "sql/export";
const DEFAULT_DDL_EXCLUDE = ["schema_migrations"];
const DEFAULT_MAX_ROWS = 50_000;
const MAX_RESULT_MODEL_BYTES = 20_000;

export const dbExportToolDescription =
  "Export table structures (DDL, CREATE TABLE files) or table data (DML, INSERT files; CSV files) from a " +
  "configured MySQL data source into .sql / .csv files on disk. Read-only against the database; MySQL only.";

function timestampSuffix(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function safeFileToken(token: string): string {
  return String(token).replace(/[^\w.-]/g, "_");
}

/** MySQL 字面量转义（默认 sql_mode：反斜杠转义与双写引号均合法）。 */
function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex").toUpperCase()}'`;
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace("T", " ")}'`;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0")}'`;
}

/** CSV 单元格渲染：NULL → 空字段；BLOB → hex；JSON 列 → JSON 文本；日期 → `YYYY-MM-DD HH:MM:SS`。 */
function renderCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** RFC 4180 序列化：含逗号/引号/换行的字段加引号，内部引号双写；首行为表头。 */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const field = (value: unknown): string => {
    const text = renderCsvValue(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(field).join(",")];
  for (const row of rows) lines.push(row.map(field).join(","));
  return `${lines.join("\n")}\n`;
}

const dbExportHandler: ToolHandler = async (input, context) => {
  const started = Date.now();
  const parsed = DbExportInputSchema.parse(input) as DbExportInput;
  const { data_source: target, scope, tables, exclude_tables: excludeTables } = parsed;
  // 缺省目标源优先取会话级选择（specs/data-source.md §7），显式入参仍最优先。
  const source = await resolveDataSource(target, context.dataSourceId);
  if (source.config.type !== "mysql") {
    throw new Error(
      `Export currently supports MySQL data sources only (data source "${source.view.name}" is ${source.config.type}).`,
    );
  }

  const outputDir = isAbsolute(parsed.output_dir ?? "")
    ? (parsed.output_dir as string)
    : resolve(context.workingDirectory, parsed.output_dir ?? DEFAULT_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const ts = timestampSuffix();
  const dbToken = safeFileToken(source.config.database);
  const files: DbExportOutput["files"] = [];
  const skipped: DbExportOutput["skipped"] = [];

  await withClient(source, async (client: DriverClient) => {
    if (scope === "ddl") {
      const exclude = new Set(excludeTables ?? DEFAULT_DDL_EXCLUDE);
      const requested = tables?.length
        ? tables
        : (await listBaseTables(source, client)).filter((table) => !exclude.has(table));
      const sections: string[] = [
        `-- DDL export: ${source.config.host}/${source.config.database}`,
        `-- exported at ${new Date().toISOString()} · ${requested.length} tables · contains DROP TABLE IF EXISTS`,
        "SET NAMES utf8mb4;",
        "SET FOREIGN_KEY_CHECKS = 0;",
        "",
      ];
      for (const table of requested) {
        try {
          const ddl = await showCreateTable(source, client, table);
          sections.push("-- ----------------------------");
          sections.push(`-- Table: ${table}`);
          sections.push("-- ----------------------------");
          sections.push(`DROP TABLE IF EXISTS \`${table.replace(/`/g, "``")}\`;`);
          sections.push(`${ddl};`);
          sections.push("");
          files.push({ table, path: "", rows: 0, truncated: false });
        } catch (error) {
          skipped.push({
            table,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      sections.push("SET FOREIGN_KEY_CHECKS = 1;");
      const path = resolve(outputDir, `${dbToken}_ddl_${ts}.sql`);
      await writeFile(path, sections.join("\n"), "utf-8");
      // 路径在落盘时才可知，统一回填
      for (const file of files) file.path = path;
      return;
    }

    // scope === "dml" / "csv"：必须显式指定表，避免无意识的全库数据拖取
    if (!tables?.length) {
      throw new Error(`scope=${scope} requires \`tables\` (list the tables you want to export).`);
    }
    const maxRows = parsed.max_rows_per_table ?? DEFAULT_MAX_ROWS;
    const where = parsed.where;
    for (const table of tables) {
      try {
        // where 片段由 selectTableRows 内部的 assertSafeWhereCondition 统一校验
        const { columns, rows, truncated } = await selectTableRows(
          source,
          client,
          table,
          maxRows,
          where,
        );
        let path: string;
        if (scope === "dml") {
          if (rows.length === 0) {
            skipped.push({ table, reason: "empty table" });
            continue;
          }
          const columnList = columns.map((column) => `\`${column.replace(/`/g, "``")}\``).join(", ");
          const whereNote = where ? ` · where: ${where.replace(/\s+/g, " ")}` : "";
          const lines: string[] = [
            `-- DML export: ${source.config.database}.${table} · ${rows.length} rows${truncated ? ` (truncated at ${maxRows})` : ""}${whereNote}`,
            `-- exported at ${new Date().toISOString()}`,
            "SET NAMES utf8mb4;",
            "",
          ];
          for (const row of rows) {
            lines.push(
              `INSERT INTO \`${table.replace(/`/g, "``")}\` (${columnList}) VALUES (${row.map(toSqlLiteral).join(", ")});`,
            );
          }
          path = resolve(outputDir, `${dbToken}_dml_${safeFileToken(table)}_${ts}.sql`);
          await writeFile(path, lines.join("\n"), "utf-8");
        } else {
          // csv：空结果保留表头文件——where 过滤下 0 行是有效结果，便于下游确认列结构
          path = resolve(outputDir, `${dbToken}_csv_${safeFileToken(table)}_${ts}.csv`);
          // UTF-8 BOM：Excel 直接打开也能正确识别中文
          await writeFile(path, `\uFEFF${toCsv(columns, rows)}`, "utf-8");
        }
        files.push({ table, path, rows: rows.length, truncated });
      } catch (error) {
        skipped.push({
          table,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  return {
    data_source: source.view,
    scope,
    output_dir: outputDir,
    files,
    skipped,
    duration_ms: Date.now() - started,
  } satisfies DbExportOutput;
};

export const dbExportToolEntry: ToolEntry = {
  capability: "Export MySQL table structures or data as .sql / .csv files into the workspace",
  metadata: {
    name: DB_EXPORT_TOOL_NAME,
    description: dbExportToolDescription,
    modelInstructions: [
      "ddl exports all base tables into one file (schema_migrations excluded by default); dml and csv require an explicit `tables` list and write one file per table.",
      "dml renders INSERT statements; csv renders RFC 4180 CSV with a header row and UTF-8 BOM. `where` (csv/dml only) filters exported rows with a plain SQL condition, without the WHERE keyword.",
      "Empty tables are skipped and reported in `skipped` (dml); csv keeps a header-only file for 0 rows. Rows are capped (default 50000/table).",
      "Files land under output_dir relative to the working directory (default sql/export). MySQL data sources only.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 120_000,
    maxOutputBytes: MAX_RESULT_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: dbExportHandler,
  inputSchema: DbExportInputJsonSchema,
  outputSchema: DbExportOutputJsonSchema,
  runtimeInputSchema: DbExportInputSchema,
  runtimeOutputSchema: DbExportOutputSchema,
  formatModelContent: formatDbExportModelContent,
  permission: {
    permission: "dbExport",
    reason: "DBExport writes .sql files into the workspace",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
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
    defaultMs: 120_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "DBExport was cancelled; partially written files are kept",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatDbExportModelContent(output: unknown): string {
  const result = output as DbExportOutput;
  const lines = [
    `exported ${result.files.length} file(s) to ${result.output_dir} (${result.duration_ms}ms)`,
  ];
  for (const file of result.files) {
    lines.push(
      `  ${file.path} — ${file.table}${file.rows > 0 ? ` · ${file.rows} rows${file.truncated ? " (truncated)" : ""}` : ""}`,
    );
  }
  for (const item of result.skipped) {
    lines.push(`  skipped ${item.table}: ${item.reason}`);
  }
  return lines.join("\n");
}
