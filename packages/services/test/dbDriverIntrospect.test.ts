// 内省查询结果归一化的行为测试：
// node-postgres 的 query() 返回 QueryResult 对象（行集合在 .rows 上），
// mysql2 返回 [rows, fields] 元组，两种形状都必须正确解构（回归 "rows.map is not a function"）。
import assert from "node:assert/strict";
import test from "node:test";
import type { DataSourceConfig } from "@zcode/shared";
import { introspectColumns, introspectTables } from "../src/data-source/dbDriver.js";

function makeConn(type: DataSourceConfig["type"]): DataSourceConfig {
  return {
    id: "ds-test",
    type,
    name: "test",
    host: "localhost",
    port: type === "mysql" ? 3306 : 5432,
    user: "u",
    password: "p",
    database: "db",
    readOnly: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 模拟 pg Client.query：返回 QueryResult 对象（非数组）。 */
function fakePgClient(rows: Record<string, unknown>[]) {
  return {
    query: async () => ({
      command: "SELECT",
      rowCount: rows.length,
      fields: [],
      rows,
    }),
  };
}

/** 模拟 mysql2 Connection.query：返回 [rows, fields] 元组。 */
function fakeMysqlClient(rows: Record<string, unknown>[]) {
  return {
    query: async () => [rows, []],
  };
}

test("PG 内省表清单：从 QueryResult.rows 取行并按 schema 限定表名", async () => {
  const client = fakePgClient([
    { schema: "public", name: "users", comment: "用户表", kind: "r" },
    { schema: "app", name: "orders", comment: "", kind: "v" },
  ]);
  const tables = await introspectTables(client, makeConn("postgresql"));
  assert.deepEqual(tables, [
    { name: "users", comment: "用户表", kind: "r" },
    { name: "app.orders", comment: "", kind: "v" },
  ]);
});

test("PG 内省字段清单：从 QueryResult.rows 取行并按表分组", async () => {
  const client = fakePgClient([
    {
      table_schema: "public",
      table_name: "users",
      column_name: "id",
      data_type: "integer",
      len: null,
      column_comment: "主键",
    },
    {
      table_schema: "public",
      table_name: "users",
      column_name: "name",
      data_type: "character varying",
      len: 64,
      column_comment: "",
    },
  ]);
  const grouped = await introspectColumns(client, makeConn("postgresql"));
  assert.deepEqual(grouped, {
    users: [
      { name: "id", type: "integer", comment: "主键" },
      { name: "name", type: "character varying(64)", comment: "" },
    ],
  });
});

test("PG 内省空结果：rows 缺失时按空集合处理不抛错", async () => {
  const client = { query: async () => ({ command: "SELECT", rowCount: 0, fields: [] }) };
  assert.deepEqual(await introspectTables(client, makeConn("postgresql")), []);
  assert.deepEqual(await introspectColumns(client, makeConn("postgresql")), {});
});

test("MySQL 内省表清单：解构 [rows, fields] 元组（回归保护）", async () => {
  const client = fakeMysqlClient([{ name: "users", comment: "用户表", kind: "BASE TABLE" }]);
  const tables = await introspectTables(client, makeConn("mysql"));
  assert.deepEqual(tables, [{ name: "users", comment: "用户表", kind: "BASE TABLE" }]);
});

test("MySQL 内省字段清单：解构 [rows, fields] 元组并按表分组（回归保护）", async () => {
  const client = fakeMysqlClient([
    { table_key: "users", name: "id", type: "int(11)", col_comment: "主键" },
  ]);
  const grouped = await introspectColumns(client, makeConn("mysql"));
  assert.deepEqual(grouped, {
    users: [{ name: "id", type: "int(11)", comment: "主键" }],
  });
});
