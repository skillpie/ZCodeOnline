// ============================================================
// DB Tools - MySQL / PostgreSQL driver (short-lived connections)
// ============================================================
// 与 host 侧 packages/services/src/data-source/dbDriver.ts 同源移植：
// - 每次操作短连接，用完即关（agent 进程不维持连接池）
// - 查询行数截断；写语句统一包事务，任一失败全部回滚
// - 只读校验：剥离前导注释后首 token 必须 ∈ {SELECT, WITH, SHOW, DESC(RIBE), EXPLAIN}

import mysql from "mysql2/promise";
import { Client } from "pg";
import { describeDataSourceConnectError, type DataSourceConfig } from "@zcode/shared";
import type { DbStatementResult, DbTargetView } from "@zcode/contracts";
import type { ResolvedDataSource } from "./store.js";

const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 60_000;
const READ_PREFIX = /^(select|with|show|describe|desc|explain)\b/i;

export function isReadStatement(sql: string): boolean {
  const text = String(sql || "").trim();
  if (!text) return false;
  // 去掉前导行注释与块注释，避免注释伪装绕过前缀判断
  const stripped = text.replace(/^(--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/i, "");
  return READ_PREFIX.test(stripped) && !/;\s*\S/.test(stripped.replace(/;\s*$/, ""));
}

/** 单个 SQL 字符串里若混入多条语句（引号外出现分号），拆成数组。 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null; // ' " `
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote !== "`") {
        cur += sql[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          cur += sql[i + 1]!;
          i++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") cur += sql[i++]!;
      cur += "\n";
      continue;
    }
    if (ch === "#" && sql[i + 1] === " ") {
      while (i < sql.length && sql[i] !== "\n") cur += sql[i++]!;
      cur += "\n";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      cur += end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface DriverClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function withClient<T>(
  source: ResolvedDataSource,
  fn: (client: DriverClient) => Promise<T>,
): Promise<T> {
  // 只包装「建立连接」阶段；SQL 执行错误在 fn 内保持原始信息透传，不做连接类翻译
  const client = await openDriverClient(source.config);
  try {
    return await fn(client);
  } finally {
    await closeDriverClient(client, source.config.type).catch(() => {});
  }
}

async function openDriverClient(conn: DataSourceConfig): Promise<DriverClient> {
  try {
    if (conn.type === "mysql") {
      return await mysql.createConnection({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        connectTimeout: CONNECT_TIMEOUT_MS,
        dateStrings: true,
        multipleStatements: false,
      });
    }
    if (conn.type === "postgresql") {
      const client = new Client({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });
      await client.connect();
      return client;
    }
    throw new Error(`Unsupported data source type: ${String(conn.type)}`);
  } catch (error) {
    // VPN / 内网场景下连接失败是常态，翻译成带排查指引的消息再交给模型
    throw new Error(describeDataSourceConnectError(error, conn));
  }
}

async function closeDriverClient(
  client: DriverClient,
  type: DataSourceConfig["type"],
): Promise<void> {
  if (type === "mysql") {
    await (client as mysql.Connection).end();
  } else {
    await (client as Client).end();
  }
}

async function execOne(
  client: DriverClient,
  source: ResolvedDataSource,
  sql: string,
  maxRows: number,
): Promise<Omit<DbStatementResult, "sql" | "ok">> {
  const started = Date.now();
  if (source.config.type === "mysql") {
    // mysql2 query 返回 [rows, fields] 元组，必须先解构
    const connection = client as mysql.Connection;
    const [rows, fields] = await connection.query({ sql, timeout: QUERY_TIMEOUT_MS });
    if (Array.isArray(rows)) {
      const truncated = rows.length > maxRows;
      return {
        columns: (fields ?? []).map((field) => field.name),
        rows: rows.slice(0, maxRows) as Record<string, unknown>[],
        row_count: rows.length,
        truncated,
        ms: Date.now() - started,
      };
    }
    const info = rows as mysql.ResultSetHeader;
    return { affected: info.affectedRows ?? 0, ms: Date.now() - started };
  }
  const result = (await client.query(sql)) as {
    rows?: Record<string, unknown>[];
    fields?: { name: string }[];
    command?: string;
    rowCount?: number;
  };
  const rows = result.rows ?? [];
  const isQuery =
    Array.isArray(rows) &&
    Boolean(result.command) &&
    /^(SELECT|SHOW|SHOW ALL)/i.test(result.command ?? "") &&
    (rows.length > 0 || /select/i.test(sql));
  if (isQuery) {
    const truncated = rows.length > maxRows;
    return {
      columns: rows.length ? Object.keys(rows[0]!) : (result.fields ?? []).map((f) => f.name),
      rows: rows.slice(0, maxRows),
      row_count: rows.length,
      truncated,
      ms: Date.now() - started,
    };
  }
  return { affected: result.rowCount ?? 0, ms: Date.now() - started };
}

export interface ExecuteBatchResult {
  data_source: DbTargetView;
  results: DbStatementResult[];
  duration_ms: number;
}

/**
 * 执行一批语句（自动拆分多条）。
 * - readOnly：任一非查询语句直接整体拒绝（不建立连接，不发语句到数据库）
 * - 非只读：写语句统一包事务，单条失败整批回滚
 */
export async function executeBatch(
  source: ResolvedDataSource,
  statements: string,
  {
    maxRows,
    readOnly,
    readOnlyReason,
  }: { maxRows: number; readOnly: boolean; readOnlyReason: string },
): Promise<ExecuteBatchResult> {
  const started = Date.now();
  const list = splitSqlStatements(statements).filter(Boolean);
  if (!list.length) {
    return {
      data_source: source.view,
      results: [{ sql: statements, ok: false, error: "No executable SQL", ms: 0 }],
      duration_ms: 0,
    };
  }
  if (readOnly) {
    const firstWrite = list.find((statement) => !isReadStatement(statement));
    if (firstWrite) {
      return {
        data_source: source.view,
        results: [
          {
            sql: firstWrite,
            ok: false,
            error: readOnlyReason,
            ms: 0,
          },
        ],
        duration_ms: 0,
      };
    }
  }
  const results = await withClient(source, async (client) => {
    const out: DbStatementResult[] = [];
    const hasWrite = list.some((statement) => !isReadStatement(statement));
    if (hasWrite) {
      await client.query(source.config.type === "mysql" ? "START TRANSACTION" : "BEGIN");
    }
    for (const sql of list) {
      try {
        const result = await execOne(client, source, sql, maxRows);
        out.push({ sql, ok: true, ...result });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        out.push({ sql, ok: false, error: message, ms: 0 });
        return out;
      }
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      out.push({
        sql: list.at(-1)!,
        ok: false,
        error: `Transaction commit failed: ${message}`,
        ms: 0,
      });
      return out;
    }
    return out;
  });
  return {
    data_source: source.view,
    results,
    duration_ms: Date.now() - started,
  };
}

// ============================================================
// Export helpers（MySQL only，与 db_cli 的导出范围一致）
// ============================================================

/** 基表清单（不含视图），按表名排序。 */
export async function listBaseTables(
  source: ResolvedDataSource,
  client: DriverClient,
): Promise<string[]> {
  if (source.config.type !== "mysql") {
    throw new Error("Export currently supports MySQL data sources only.");
  }
  const connection = client as mysql.Connection;
  // mysql2 query 返回 [rows, fields] 元组，必须先解构
  const [rows] = (await connection.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
    [source.config.database],
  )) as [Array<{ name: string }>, unknown];
  return rows.map((row) => row.name);
}

/** SHOW CREATE TABLE 的建表语句（含字符集/引擎）。表名做反引号转义。 */
export async function showCreateTable(
  source: ResolvedDataSource,
  client: DriverClient,
  table: string,
): Promise<string> {
  const connection = client as mysql.Connection;
  const quoted = `\`${table.replace(/`/g, "``")}\``;
  const [rows] = (await connection.query(`SHOW CREATE TABLE ${quoted}`)) as [
    Array<{ "Create Table"?: string }>,
    unknown,
  ];
  const ddl = rows[0]?.["Create Table"];
  if (!ddl) throw new Error(`SHOW CREATE TABLE returned nothing for ${table}`);
  return ddl;
}

/** 读一张表的全部数据（LIMIT 封顶），返回行列数组以便逐行转 INSERT。 */
export async function selectTableRows(
  source: ResolvedDataSource,
  client: DriverClient,
  table: string,
  maxRows: number,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  const connection = client as mysql.Connection;
  const quoted = `\`${table.replace(/`/g, "``")}\``;
  const [rows, fields] = (await connection.query(
    `SELECT * FROM ${quoted} LIMIT ${Math.floor(maxRows) + 1}`,
  )) as [Record<string, unknown>[], mysql.FieldPacket[]];
  const columns = (fields ?? []).map((field) => field.name);
  const truncated = rows.length > maxRows;
  const bounded = truncated ? rows.slice(0, maxRows) : rows;
  return {
    columns,
    rows: bounded.map((row) => columns.map((column) => row[column])),
    truncated,
  };
}
