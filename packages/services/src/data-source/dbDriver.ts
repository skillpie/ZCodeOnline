/**
 * 数据库驱动层：MySQL（mysql2）与 PostgreSQL（pg），均为纯 JS 驱动。
 * 移植自 fengqun-dba `src/main/db.js`：
 * - 每次操作短连接，用完即关（Host 不维持连接池，避免泄漏）
 * - 查询行数截断；写语句统一包事务，任一失败全部回滚
 * - 只读模式仅放行 SELECT / WITH / SHOW / DESC(RIBE) / EXPLAIN
 */

import mysql from "mysql2/promise";
import { Client } from "pg";
import type {
  DataSourceConfig,
  DataSourceStatementOutcome,
  DataSourceStatementResult,
  DataSourceTable,
} from "@zcode/shared";
import { describeDataSourceConnectError } from "@zcode/shared";

export const MAX_QUERY_ROWS_DEFAULT = 200;
export const CONNECT_TIMEOUT_MS = 8000;
export const QUERY_TIMEOUT_MS = 60_000;

const READ_PREFIX = /^(select|with|show|describe|desc|explain)\b/i;

export function isReadStatement(sql: string): boolean {
  const text = String(sql || "").trim();
  if (!text) return false;
  // 去掉前导行注释与块注释，避免注释伪装绕过前缀判断
  const stripped = text.replace(/^(--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/i, "");
  return READ_PREFIX.test(stripped) && !/;\s*\S/.test(stripped.replace(/;\s*$/, ""));
}

/** 单个 SQL 字符串里若混入多条语句（引号外出现分号），拆成数组 */
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
        // 双写转义（'' / ""）
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

/** 短连接执行：建立连接 → fn → 无论成败关闭连接。连接类错误翻译为带排查指引的消息。 */
async function withClient<T>(
  conn: DataSourceConfig,
  fn: (client: DriverClient) => Promise<T>,
): Promise<T> {
  // 只包装「建立连接」阶段；SQL 执行错误在 fn 内保持原始信息透传，不做连接类翻译
  const client = await openDriverClient(conn);
  try {
    return await fn(client);
  } finally {
    await closeDriverClient(client, conn.type).catch(() => {});
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
    throw new Error(`不支持的数据库类型：${conn.type as string}`);
  } catch (error) {
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

/** 两种驱动共用的最小查询面（避免把驱动类型渗到上层）。 */
interface DriverClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function testConnection(
  conn: DataSourceConfig,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    return await withClient(conn, async (client) => {
      let version = "";
      if (conn.type === "mysql") {
        // mysql2 query 返回 [rows, fields] 元组，必须先解构（否则拿的是元组本身）
        const [rows] = (await client.query("SELECT VERSION() AS v")) as [
          Array<{ v?: unknown }>,
          unknown,
        ];
        version = String(rows?.[0]?.v ?? "");
      } else {
        const result = (await client.query("SHOW server_version")) as {
          rows?: Array<{ server_version?: unknown }>;
        };
        version = String(result.rows?.[0]?.server_version ?? "");
      }
      return { ok: true as const, version };
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 执行单条语句，归一化结果：rows（截断）或 ok（受影响行数）。 */
async function execOne(
  client: DriverClient,
  conn: DataSourceConfig,
  sql: string,
  maxRows: number,
): Promise<DataSourceStatementResult> {
  const started = Date.now();
  if (conn.type === "mysql") {
    const connection = client as mysql.Connection;
    const [rows, fields] = await connection.query({ sql, timeout: QUERY_TIMEOUT_MS });
    if (Array.isArray(rows)) {
      const truncated = rows.length > maxRows;
      return {
        kind: "rows",
        columns: (fields ?? []).map((field) => field.name),
        rows: rows.slice(0, maxRows) as Record<string, unknown>[],
        rowCount: rows.length,
        truncated,
        ms: Date.now() - started,
      };
    }
    const info = rows as mysql.ResultSetHeader;
    return {
      kind: "ok",
      affected: info.affectedRows ?? 0,
      ms: Date.now() - started,
    };
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
      kind: "rows",
      columns: rows.length ? Object.keys(rows[0]!) : (result.fields ?? []).map((f) => f.name),
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated,
      ms: Date.now() - started,
    };
  }
  return { kind: "ok", affected: result.rowCount ?? 0, ms: Date.now() - started };
}

/**
 * 执行一批语句（数组或含多条语句的字符串，自动拆分）：
 * - 只读模式拦截非查询语句；放行的写语句统一包事务，任一失败全部回滚
 * - 单条语句失败立即中止并返回错误（不吞错，便于上层自愈）
 */
export async function executeStatements(
  conn: DataSourceConfig,
  statements: string | string[],
  { maxRows, readOnly }: { maxRows?: number; readOnly: boolean },
): Promise<{ ok: boolean; error: string | null; results: DataSourceStatementOutcome[] }> {
  const list = (Array.isArray(statements) ? statements : [statements])
    .flatMap((statement) => splitSqlStatements(String(statement || "")))
    .filter(Boolean);
  if (!list.length) {
    return { ok: false, error: "没有可执行的 SQL", results: [] };
  }

  if (readOnly) {
    const firstWrite = list.find((statement) => !isReadStatement(statement));
    if (firstWrite) {
      return {
        ok: false,
        results: [],
        error: `只读数据源禁止执行非查询语句：${firstWrite.slice(0, 120)}`,
      };
    }
  }

  const limit = Math.max(1, maxRows ?? MAX_QUERY_ROWS_DEFAULT);

  return withClient(conn, async (client) => {
    const results: DataSourceStatementOutcome[] = [];
    const hasWrite = list.some((statement) => !isReadStatement(statement));
    // 纯查询不显式开事务；有写语句才包事务（与参考实现一致）
    if (hasWrite) {
      await client.query(conn.type === "mysql" ? "START TRANSACTION" : "BEGIN");
    }
    for (const sql of list) {
      try {
        const result = await execOne(client, conn, sql, limit);
        results.push({ sql, ok: true, ...result });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        results.push({ sql, ok: false, error: message });
        return { ok: false, error: message, results };
      }
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `事务提交失败：${message}`, results };
    }
    return { ok: true, error: null, results };
  });
}

/** 完整内省：表 + 字段 + 注释（含视图）。 */
export async function introspect(conn: DataSourceConfig): Promise<DataSourceTable[]> {
  return withClient(conn, async (client) => {
    const [tables, columnGroups] = await Promise.all([
      introspectTables(client, conn),
      introspectColumns(client, conn),
    ]);
    return tables.map((table) => ({ ...table, columns: columnGroups[table.name] ?? [] }));
  });
}

/** 表清单 + 注释：MySQL information_schema / PG pg_class+obj_description（含视图、分区表）。 */
async function introspectTables(
  client: DriverClient,
  conn: DataSourceConfig,
): Promise<Omit<DataSourceTable, "columns">[]> {
  if (conn.type === "mysql") {
    // mysql2 query 返回 [rows, fields] 元组，必须先解构；
    // MySQL 8 的 information_schema 返回大写列名（TABLE_NAME 等），必须显式别名
    const [rows] = (await (client as mysql.Connection).query(
      "SELECT table_name AS name, table_comment AS comment, table_type AS kind FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
      [conn.database],
    )) as [Array<{ name: string; comment: string; kind: string }>, unknown];
    return rows.map((row) => ({ name: row.name, comment: row.comment || "", kind: row.kind }));
  }
  const rows = (await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment, c.relkind AS kind
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
     ORDER BY n.nspname, c.relname`,
  )) as Array<{ schema: string; name: string; comment: string; kind: string }>;
  return rows.map((row) => ({
    name: row.schema === "public" ? row.name : `${row.schema}.${row.name}`,
    comment: row.comment || "",
    kind: row.kind,
  }));
}

/** 字段清单 + 注释，按表分组返回。 */
async function introspectColumns(
  client: DriverClient,
  conn: DataSourceConfig,
): Promise<Record<string, { name: string; type: string; comment: string }[]>> {
  const grouped: Record<string, { name: string; type: string; comment: string }[]> = {};
  if (conn.type === "mysql") {
    // 注意：MySQL 8 的 information_schema 返回大写列名（TABLE_NAME 等），必须显式别名；
    // mysql2 query 返回 [rows, fields] 元组，必须先解构
    const [rows] = (await (client as mysql.Connection).query(
      `SELECT table_name AS table_key, column_name AS name, column_type AS type,
              is_nullable AS nullable, column_comment AS col_comment
       FROM information_schema.columns WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [conn.database],
    )) as [Array<{ table_key: string; name: string; type: string; col_comment: string }>, unknown];
    for (const row of rows) {
      (grouped[row.table_key] ??= []).push({
        name: row.name,
        type: row.type,
        comment: row.col_comment || "",
      });
    }
    return grouped;
  }
  const rows = (await client.query(
    `SELECT table_schema, table_name, column_name, data_type, udt_name, character_maximum_length AS len, is_nullable,
            COALESCE(col_description(('"' || table_schema || '"."' || table_name || '"')::regclass, ordinal_position), '') AS column_comment
     FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg\\_toast%' AND table_schema NOT LIKE 'pg\\_temp%'
     ORDER BY table_schema, table_name, ordinal_position`,
  )) as Array<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    len: number | null;
    column_comment: string;
  }>;
  for (const row of rows) {
    const tableName =
      row.table_schema === "public" ? row.table_name : `${row.table_schema}.${row.table_name}`;
    const type = row.len ? `${row.data_type}(${row.len})` : row.data_type;
    (grouped[tableName] ??= []).push({
      name: row.column_name,
      type,
      comment: row.column_comment || "",
    });
  }
  return grouped;
}
