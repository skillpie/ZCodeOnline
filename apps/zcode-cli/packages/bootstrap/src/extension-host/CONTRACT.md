# cli-extension-host

进程内 TS/JS extension 的发现、加载与宿主映射。extension 是导出 setup 函数的
TS/JS 模块，经 jiti 免编译加载进宿主进程，把「工具」与「生命周期事件订阅」
注册进 ZCode 运行时——补齐插件市场（MCP 进程外工具 + markdown 指令）与
宿主内富元数据工具之间的能力档。

## Public surface（`index.ts`）

| 导出 | 意图 |
| --- | --- |
| `loadExtensions(options)` | 发现目录、加载扩展，产出 `ToolEntry[]` / `HookRegistration[]` / 诊断 |
| `createExtensionAwareHookRunner(input)` | 组装 configured + extension 合并 runner，经 `deps.hookRunner` 注入 |

## Authoring API（v1）

```ts
export default function (api) {
  api.tool({
    name: "myext_lookup",
    description: "…",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
    readOnly: true,
    async execute(input, context) { return { ok: true }; },
  });
  api.on("SessionStart", async (input) => { /* observe */ });
}
```

放置位置：

- 用户级：`~/.zcode/extensions/<name>.ts`（或含 `index.ts` 的目录）
- 显式受信目录：环境变量 `ZCODE_EXTENSIONS_EXTRA_DIRS`（路径分隔符分隔）
- 总开关：`ZCODE_DISABLE_EXTENSIONS=1`

## Defaults（安全默认）

| 字段 | 非只读 | 只读 |
| --- | --- | --- |
| `needsApproval` | `true`（审批面板出场） | `false` |
| `riskLevel` | `medium` | `low` |
| `sideEffectScope` | `workspace` | `none` |
| `allowedInPlanMode` | `false` | `false` |
| `concurrentSafe` | `false` | `true` |

显式 `needsApproval: false` 允许但记 warning 日志。扩展工具与内置工具重名：
内置工具在 runtime 装配时后注册覆盖，加载期发 `extension_tool_name_conflict`
warning。`mcp__` 前缀保留给 MCP 工具，扩展不可用。

## Trust model（v1）

进程内代码权限等于宿主。v1 的信任边界是**目录来源**：

- `~/.zcode/extensions`：与用户级 MCP server / skills 同一信任层级，默认加载；
- 工作区扩展目录**不隐式加载**：发现即发 `extension_project_dir_skipped`
  info 诊断，需经 `ZCODE_EXTENSIONS_EXTRA_DIRS` 显式授权（授权即信任）；
- workspace-hook 那套 per-file 信任审核 UI 属 Phase 3，接入后替换
  `ZCODE_EXTENSIONS_EXTRA_DIRS` 的手工授权。

事件回调失败不产生 hook 决策（fail-open，等价 shell hook 非零退出）；
setup 抛错则整个扩展的注册一并丢弃（不留半个扩展）。

## Non-goals（v1 刻意不做）

- 模型请求路径事件（`context` / `before_provider_request`）——需要 core 热区
  新增接缝，与 fork 低冲突策略冲突；
- `registerCommand` / TUI 组件 / provider / 虚拟模型注册；
- workflow child runtime（`script-workflow-child-runtime.ts` 等）不注入扩展，
  扩展只作用于主会话装配点（`create-app.ts`）；
- 不承诺 Pi / dsh 插件二进制兼容——跨 harness 互操作只走 MCP / skills /
  hooks 数据格式层。

## v1.5 候选需求（2026-10-27 查数手册 dogfood 调查得出）

首个 dogfood 目标（数据源表清单+查数手册注入）调查后**确认不迁**：它是
turn 管道耦合的产品功能（常规轮 + guide drain 双调用点、绑定经协议字段逐轮
下发），留 core。调查暴露的 API 边界按价值排序记录：

1. **钩子看不到 turn 选项**：`UserPromptSubmitHookInput` 不携带
   `sendText.dataSourceId` 这类逐轮协议字段；会话级绑定对 extension 不可见
   （activeId 近似在多数据源场景会注错）。
2. **drain 路径不触发钩子**：guide/steer 中途注入不跑 UserPromptSubmit，
   中途换绑的上下文更新无法经 extension 实现。
3. **hook 附加上下文 24K 字符封顶**（`hooks.ts` `HOOK_CONTEXT_MAX_CHARS`）
   且多上下文共享配额——大体积知识注入（实测手册 38–43KB）需要独立通道或
   可配置上限。
4. **无历史去重原语**：核心 reminder 靠扫描历史附件幂等；extension 只有进程
   内状态，重启后重复注入一次。若未来做「会话附件」类 API 需一并设计。

## Runtime dependency（jiti）

jiti 是唯一随 feature 新增的运行时依赖，且必须**外部化**（内联进 cjs bundle
会被 esbuild 改写，无法动态加载用户文件）。三种形态的解析由
`loadJitiFactory` 的候选链负责，任一命中即用：

1. 裸说明符 `jiti`——dev 与 CLI 发行包（runtime/node_modules，打包器按产物
   引用自动收录）；
2. `<bundle 目录>/runtime-deps/jiti/lib/jiti.cjs`——桌面安装包布局；
3. `<bundle 目录>/node_modules/jiti/lib/jiti.cjs`——传统布局兜底。

**桌面安装包禁止把 jiti stage 到任何名为 node_modules 的目录**：electron-
builder 会按 desktop 生产依赖裁剪 extraResources 拷贝树里的 node_modules，
2026-10-27 曾因此把 glm/node_modules 整目录剪掉、顶层静态 import 拖死启动
准备进程（"Startup preparation failed / transport_closed"）。现在桌面 stage
到 `glm/runtime-deps/jiti`，且加载是惰性的：jiti 缺席时发
`extension_loader_unavailable` 诊断并整体降级，绝不阻断应用启动。

## Fork 策略

本模块全部为增量文件；对既有文件的改动只有 `create-app.ts` 装配行的个位数
diff 与 bootstrap `package.json` 的 jiti 依赖。core 零改动：工具走
`AgentRuntimeDeps.toolRegistry`、事件走 `AgentRuntimeDeps.hookRunner`，runner
合并镜像 `core/src/runtime/helpers/runtime-tools.ts`（镜像点两处注释互指，
上游改动该文件时需同步核对 `module.ts` 的门控与 EMPTY 默认值）。
