/**
 * 数据源管理领域类型与纯函数（连接归一化 / 脱敏视图）。
 *
 * 参考实现：fengqun-dba `src/main/connections.js`。取舍一致：本机个人工具，
 * 密码由 Host 端明文落盘；RPC 回传渲染层的一律是脱敏视图（hasPassword），拿不到明文。
 * 本文件只放类型与纯函数，不出现 IO。
 */

export const DATA_SOURCE_TYPES = ["mysql", "postgresql"] as const;
export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

export const DATA_SOURCE_DEFAULT_PORTS: Record<DataSourceType, number> = {
  mysql: 3306,
  postgresql: 5432,
};

/** 新建 / 编辑入参。编辑时 password 留空表示保持原密码（UI 拿到的是脱敏视图）。 */
export interface DataSourceInput {
  id?: string;
  type: DataSourceType;
  name?: string;
  host: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
  readOnly?: boolean;
}

/** Host 端持久化的完整配置（含密码），不出 Host 进程。 */
export interface DataSourceConfig {
  id: string;
  type: DataSourceType;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  readOnly: boolean;
  createdAt: string;
}

/** 列表与 RPC 回传给 UI 的脱敏视图。 */
export interface DataSourceView {
  id: string;
  type: DataSourceType;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  readOnly: boolean;
  createdAt: string;
  hasPassword: boolean;
}

export interface DataSourceColumn {
  name: string;
  type: string;
  comment: string;
}

export interface DataSourceTable {
  name: string;
  comment: string;
  /** mysql: BASE TABLE / VIEW；postgresql: r / p / v / m / f */
  kind: string;
  columns: DataSourceColumn[];
}

/** 一次表结构同步的快照（整库覆盖写）。 */
export interface DataSourceSchemaSnapshot {
  dataSourceId: string;
  fetchedAt: string;
  tables: DataSourceTable[];
}

/** 单条语句结果：查询（行数截断）或更新（受影响行数）。 */
export type DataSourceStatementResult =
  | {
      kind: "rows";
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      ms: number;
    }
  | { kind: "ok"; affected: number; ms: number };

export type DataSourceStatementOutcome =
  | ({ sql: string; ok: true } & DataSourceStatementResult)
  | { sql: string; ok: false; error: string };

/** 一批 SQL 的执行结果（写语句同事务，任一失败全部回滚）。 */
export interface DataSourceExecuteResult {
  ok: boolean;
  error: string | null;
  results: DataSourceStatementOutcome[];
}

/** 保存 / 激活的统一返回：最新脱敏配置 + 自动同步结果（一次往返）。 */
export interface DataSourceMutationResult {
  dataSource: DataSourceView;
  activeId: string | null;
  schema: DataSourceSchemaSnapshot | null;
  /** 同步失败不回滚保存/切换，错误单独带回。 */
  syncError: string | null;
}

export type DataSourceTestResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

export type DataSourceListResult = {
  dataSources: DataSourceView[];
  activeId: string | null;
};

/** 归一化一条连接（新建传 input；编辑传 existing 保证 id/createdAt/原密码不丢）。 */
export function normalizeDataSourceInput(
  input: DataSourceInput,
  existing?: DataSourceConfig,
): { ok: true; config: DataSourceConfig } | { ok: false; error: string } {
  const type = String(input.type || "").toLowerCase() as DataSourceType;
  if (!(DATA_SOURCE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: "数据库类型仅支持 mysql / postgresql" };
  }
  const host = String(input.host || "").trim();
  if (!host) return { ok: false, error: "主机地址不能为空" };
  const database = String(input.database || "").trim();
  if (!database) return { ok: false, error: "数据库不能为空" };

  let port = Number(input.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    port = DATA_SOURCE_DEFAULT_PORTS[type];
  }

  const pwdInput = String(input.password == null ? "" : input.password);
  const password = pwdInput || (existing ? existing.password : "");

  const config: DataSourceConfig = {
    id: existing?.id || String(input.id || "") || newDataSourceId(),
    type,
    name: String(input.name || "").trim() || `${host}/${database}`,
    host,
    port,
    user: String(input.user || "").trim() || (type === "mysql" ? "root" : "postgres"),
    password,
    database,
    readOnly:
      input.readOnly === undefined
        ? existing
          ? existing.readOnly !== false
          : true
        : input.readOnly !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  return { ok: true, config };
}

/** 列表页展示用的脱敏摘要（密码不回传渲染层）。 */
export function maskDataSource(config: DataSourceConfig): DataSourceView {
  const { password, ...rest } = config;
  return { ...rest, hasPassword: Boolean(password) };
}

export function newDataSourceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 把驱动的底层连接错误翻译成带排查指引的消息（纯函数，无 IO；宿主服务与 agent 工具共用）。
 * 背景：库地址常在 VPN / 内网之后，ETIMEDOUT / ENOTFOUND 这类错误几乎总是「VPN 未连或
 * 网络不通」，透传原始报错（如 connect ETIMEDOUT）用户无从下手；这里给出分类结论，
 * 并始终附上原始错误便于排障。SQL 执行阶段的错误不走这里。
 */
export function describeDataSourceConnectError(
  error: unknown,
  target: { host: string; port: number; type: string },
): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);
  const endpoint = `${target.host}:${target.port}（${target.type}）`;
  const suffix = ` [原始错误: ${message || code || "unknown"}]`;

  if (code === "ETIMEDOUT" || /connect ETIMEDOUT|timeout expired/i.test(message)) {
    return `连接超时：${endpoint} 无响应。该地址通常需要 VPN / 内网环境，请确认 VPN 已连接后重试${suffix}`;
  }
  if (code === "ECONNREFUSED") {
    return `连接被拒绝：${endpoint} 端口未监听或被防火墙拦截${suffix}`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `域名解析失败：无法解析 ${target.host}，内网域名通常需要连接 VPN${suffix}`;
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `网络不可达：${endpoint}，请确认 VPN 与路由设置${suffix}`;
  }
  if (code === "ECONNRESET") {
    return `连接被重置：${endpoint}，多为网络或 VPN 中途断开${suffix}`;
  }
  // PostgreSQL 的文字型报错（无 code 或 code 不在上列）
  if (/could not connect to server/i.test(message)) {
    return `无法连接：${endpoint}，请确认 VPN / 内网与数据库地址${suffix}`;
  }
  if (/password authentication failed/i.test(message)) {
    return `认证失败：用户名或密码不正确${suffix}`;
  }
  if (/does not exist|unknown database/i.test(message)) {
    return `数据库不存在：请检查库名是否正确${suffix}`;
  }
  if (/access denied/i.test(message)) {
    return `访问被拒绝：账号无权连接该库${suffix}`;
  }
  return message || code || "unknown connection error";
}
