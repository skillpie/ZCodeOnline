# Spec: 数据源管理（Data Source）

> 参考实现：`~/Projects/fengqun/fengqun-dba`（远方问数）的连接管理、核心 SQL 读写引擎与表结构同步。
> 本功能为**附加式**新增：除注册点外全部为新文件，尽量不动现有代码，便于后续合并 ZCode 上游。

## 1. 产品规则

- 聊天输入框底栏（leadingActions）新增「数据源」入口按钮，点击弹出数据源面板。
- 支持 MySQL 与 PostgreSQL；数据源可新增、编辑、删除、切换激活。
- 每个数据源有访问模式：`只读`（默认，拦截非查询语句）/ `读写`（写语句统一包事务，任一失败全部回滚）。
- 添加数据源（保存）与切换激活时，**自动同步一次表结构**（内省库表/字段/注释并缓存）。
- 不做：数据语义层、问答记忆、自然语言问数（后续可基于本服务的 executeSql 扩展）。

## 2. 状态所有者

```text
UI（Zustand dataSourceStore，投影缓存）
  │  仅通过 RPC 读写，不持久化、不持有第二事实
  ▼
Host 端 IDataSourceService（唯一所有者）
  ├─ config.json     数据源配置 + activeId（原子写）
  └─ schema-cache/<id>.json  表结构快照（内省结果覆盖写）
```

- 配置与表结构快照只落在 Host 端 `getAppConfigDir()/data-sources/`（随 `ZCODE_DATA_BASE_DIR` 隔离）。
- 密码明文存本机配置文件（与参考实现及 DBA 技能同一取舍：本机个人工具）；RPC 回传一律脱敏（`hasPassword`），渲染层拿不到明文。编辑时密码留空 = 保持原密码。
- UI store 仅是投影：刷新靠显式 `load()`；不做跨窗口广播（本功能状态无跨窗口一致性要求）。

## 3. 接口（channel：`data-source`）

```ts
interface IDataSourceService {
  listDataSources(): Promise<{ dataSources: DataSourceView[]; activeId: string | null }>;
  saveDataSource(input: DataSourceInput): Promise<DataSourceMutationResult>;
  deleteDataSource(id: string): Promise<void>;
  activateDataSource(id: string): Promise<DataSourceMutationResult>;
  testDataSource(
    input: DataSourceInput,
  ): Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  syncSchema(id: string): Promise<DataSourceMutationResult>;
  getSchemaSnapshot(id: string): Promise<DataSourceSchemaSnapshot | null>;
  executeSql(
    id: string,
    sql: string,
    options?: { maxRows?: number },
  ): Promise<DataSourceExecuteResult>;
}
```

- `DataSourceMutationResult = { dataSource: DataSourceView; activeId: string | null; schema: DataSourceSchemaSnapshot | null; syncError: string | null }`：保存/激活返回最新脱敏配置与同步结果，一次往返完成「保存 + 自动同步」。
- `executeSql` 是从参考实现移植的核心读写引擎（只读拦截 + 写事务 + 行数截断），当前 UI 不直接暴露 SQL 控制台，供后续问数/Agent 能力复用。

## 4. 事件顺序与失败语义

- **添加**：表单「测试连接」为显式动作（失败可继续编辑）；保存只做归一化+持久化 → 若为首个数据源自动成为激活源 → 内省并覆盖快照 → 返回；同步失败不回滚保存，返回 `syncError`。
- **切换**：写 activeId（原子写）→ 内省并覆盖快照 → 返回；同步失败不影响激活结果。
- **同步**：覆盖式（force 内省），幂等；进行中的同步以「最后完成者为准」，无跨请求合并。
- **删除**：删除配置 + 内存缓存 + 磁盘快照；若删的是激活源，activeId 置空。
- 内省/执行均「每次短连接，用完即关」，Host 不维持长连接池（与参考实现一致，避免连接泄漏）。
- 只读拦截在执行前判定：剥离前导注释后首 token 必须 ∈ {SELECT, WITH, SHOW, DESCRIBE, DESC, EXPLAIN}，且不含第二条语句；写语句批内任一失败 → 整批 ROLLBACK。
- **连接类错误翻译**（VPN 场景）：库地址常在 VPN/内网之后，连接超时（ETIMEDOUT，8s）、域名解析失败（ENOTFOUND/EAI_AGAIN）、拒绝/不可达/重置等在连接阶段被 `describeDataSourceConnectError`（shared 纯函数，宿主与 agent 两侧驱动共用）翻译为带排查指引的中文消息并保留原始错误；SQL 执行阶段错误原样透传。UI（测试连接/保存同步/切换同步）与 Agent 工具（DBQuery/DBExecute 的 error 字段）都呈现翻译后的消息，模型可据此提示用户连接 VPN。

## 5. 验收场景

1. 底栏点「数据源」→ 面板列出数据源；无数据源时显示空态与「新建」引导。
2. 新建 MySQL/PG 数据源：填主机/端口/账号/库/密码 → 测试连接通过 → 保存后面板自动出现表数量（表结构已自动同步）。
3. 点击列表项切换激活 → 表结构自动刷新为该源内容；按钮文案显示当前激活源名称。
4. 只读模式执行写语句被拒绝并提示；读写模式写语句走事务。
5. 编辑时清空密码保存 → 原密码保留；删除数据源 → 列表与快照同步清理。
6. Web（5173/3030）与桌面端均可使用（服务注册于 createLocalServices，三端同构）。
7. 对话中用 `DBExport` `scope=csv` + `where` 导出 → 每表生成带表头、UTF-8 BOM 的 RFC 4180 CSV；非法 `where`（分号/注释/`INTO OUTFILE`/`FOR UPDATE` 等）在查询前被拒绝并在 `skipped` 里报因。

## 6. Agent 内置工具接入（对话查库）

配置好数据源后，对话中的 Agent 通过三个内置工具（`@zcode/core` ToolEntry，注册于
`apps/zcode-cli/packages/core/src/tool/handlers/index.ts` 的 `builtInTools`）按 tool_use 自主查库：

| 工具        | 语义                                                                                                                                                                                                                    | 权限                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `DBSchema`  | 列数据源 / 按关键词搜表 / 查表字段（读本地表结构缓存，不实时内省）                                                                                                                                                      | 只读，自动放行                                                     |
| `DBQuery`   | 只读 SQL（SELECT/WITH/SHOW/DESC/EXPLAIN，handler 强制拦截，与数据源模式无关）                                                                                                                                           | 只读，自动放行                                                     |
| `DBExecute` | 写 SQL（读写模式数据源才可执行，包事务）                                                                                                                                                                                | `alwaysAsk`，任何权限模式（含 yolo/plan）逐次确认，且不可记忆放行  |
| `DBExport`  | 表结构导出为 .sql、数据导出为 .sql/.csv（对齐 db_cli `--export-ddl/--export-dml` 并扩展 CSV，仅 MySQL；DDL 单文件含 DROP；DML/CSV 逐表文件、行数封顶；DML 空表跳过，CSV 空结果保留表头；`where` 条件可过滤 csv/dml 行） | 写 workspace 文件：needsApproval（对齐 Write，medium；可记忆放行） |

- **「查不查」由模型判断**（tool_use 依问题与工具描述决定）；「能不能写」由工具实现按数据源 `readOnly` 配置强制拦截，双保险。
- agent 侧只读 host 落盘的 `~/.zcode/v2/data-sources/`（config.json + schema-cache/），路径公式与 `shared-credentials.ts` 一致（`ZCODE_DATA_BASE_DIR ?? homedir()`）；agent 不写这两个文件，也不实时内省——表结构一律以面板同步的缓存为准，未同步时提示用户去面板同步。
- agent 进程是独立于 host 的 CLI runtime，驱动依赖（mysql2/pg）声明在 `apps/zcode-cli/packages/core/package.json` 并被 esbuild 内联进 `zcode.cjs`，与 `@zcode/services` 的同名驱动是两份独立实现（宿主与 agent 不共享代码，避免跨包依赖反转）。
- 修改工具代码后需 `pnpm --filter @zcode/cli... build` 并重启宿主（dev:web / dev:desktop）才会生效。

## 7. 会话级数据源选择与 DB 工具提权

DB 工具不再对 UI 会话无条件可见：**新建对话默认未选择数据源，用户为该对话选择数据源后，
Agent 从被选中的那一轮起才获得 DB 工具（提权）**；未选择数据源的对话轮对模型隐藏四个 DB 工具。

### 7.1 产品规则

- 会话级选择（conversation binding）与全局激活（`activeId`）是两个概念：
  - **会话级选择**：本对话用哪个源；新建对话（draft scope）默认为空。面板勾选状态、
    输入框按钮文案均以它为准；未选择时按钮只显示图标，不展示「未选择」占位文案。
  - **全局激活**：点击列表项仍会激活该源（触发表结构同步、更新 `activeId`），维持
    §6 的工具侧 fallback 解析（`data_source` 入参缺省 → `activeId`）不变。
- 面板无独立的「不使用数据源」按钮：**再次点击已勾选的列表项**即把当前对话恢复为
  未选择（收回提权）；点击未勾选项则为该对话选择并激活新源。
- 选择是纯 renderer 意图：不改变数据源配置事实，唯一的 Host 侧痕迹是激活与表结构同步。

### 7.2 状态所有者

```text
UI（composerDraftStore，per-scope 会话草稿）
  └─ V4ComposerDraft.dataSourceId  本对话选择；draft scope 默认缺省（未选择），
     promote 到真实会话 scope 时随草稿整体转移
UI（dataSourceStore，投影缓存）
  └─ 列表 / activeId 仍是 Host 的投影，会话选择校验以投影列表为准
Host（zcodeAgentService 信封装配）
  └─ 唯一提权裁决点：按 payload 是否携带 dataSourceId 合并 turn 级 toolDisallowlist
CLI（bootstrap / core）
  └─ 机械执行：toolDisallowlist 经既有 startPromptTurn → turn-loop 管道逐轮过滤 provider 工具面
```

### 7.3 接口（协议 additive 字段）

- `sendText.dataSourceId?: string`：本对话已选择的数据源 id；是「本轮提权」的信号。
- `createSession.firstInput.dataSourceId?: string`：无预热 fallback 建会话首发的同义字段。
- `createSession.firstInput.toolDisallowlist?: string[]`：与 sendText 同型的轮级禁用名单；
  Host 在 `firstInput` 未携带 `dataSourceId` 时注入 DB 工具名。
- 字段值除 Host 门控判定外暂无其他消费方；CLI 侧不解析数据源绑定（工具仍按 §6 fallback
  `activeId`，与现状一致）。后续如需按会话硬绑定目标源，可从该字段接线。

### 7.4 事件顺序与失败语义

- 提交冻结：点击发送时从草稿读取 `dataSourceId` 并校验其仍存在于数据源投影列表；
  悬挂 id（源已删除）按未选择处理，不随 submission 携带。
- Host 门控（`buildConversationCommandEnvelope`，桌面与 Web 同源）：
  - 普通 `sendText` 未携带 `dataSourceId` → 合并 `DBQuery/DBSchema/DBExecute/DBExport`
    进 `toolDisallowlist`（轮级、registry 保留、只对模型隐藏）。
  - `createSession.firstInput` 未携带 `dataSourceId` → 同型注入 `firstInput.toolDisallowlist`。
  - **automation / off-peak / goal 轮不注入**（保持 §6 的全量工具面）：定时任务在配置时
    已隐含数据源意图，fail-open 避免打断既有自动化。
  - DB 工具名在 Host 侧按名收口（宿主不依赖 CLI contracts 包）；CLI 侧增删 DB 工具须同步。
- turn 级名单的既有语义免费获得：busy 队列回放、steer/guide 续轮均携带已注入名单；
  子代理工具面仍由会话级配置与 profile 规则约束（与 automation 轮名单同一边界，不在本轮收窄）。
- 旧 CLI 兼容：schema 为非 strict zod，未知键静默剥离 → 旧 CLI 上首轮 fail-open（工具可见），
  与 `offPeakToolEnabled` 同一取舍。
- TUI / headless CLI 不经过 Host 信封装配，DB 工具保持 §6 的无条件注册，不受本节影响。

### 7.5 验收场景

1. 新建对话未选择数据源：发送「查一下订单表」→ 模型工具面无 DB 四工具。
2. 面板选择某源（自动激活 + 同步表结构）后发送 → 该轮起 DB 四工具可见可用。
3. 对话中途选择 / 切换 / 再次点击已勾选项取消选择 → 自下一轮起提权、换绑、收回。
4. 删除已被某对话选择的数据源后再发送 → 按未选择处理（工具隐藏），不报悬空绑定。
5. 数据源面板勾选、按钮文案跟随会话级选择；不同会话互不影响。
6. automation（cron）轮会话中 DB 工具仍可用；手机 / Web 与桌面行为一致（同一 Host 信封）。
