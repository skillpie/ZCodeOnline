## Subagent 结果摘要化（result digest）实施计划

### 背景与目标

Subagent 完成后，最终报告全文进入主 agent 上下文：0~120KB 区间的结果不经任何压缩直通（最大约 3 万 token）；后台 agent 的 task-notification 路径同样内嵌全文、120KB 硬截断（`core/runtime-task/notification.ts:18`）。目标：超过阈值的结果自动生成摘要回传主上下文，全文落盘 artifact 可追溯，摘要失败时行为与现状完全一致（绝不因摘要机制丢失或破坏结果）。

关键事实（已核实）：`formatAgentOutputForModel`（`core/tool/handlers/agent.ts:130`）同时决定**模型可见面**和 **UI 持久化展示面**，改这一处 UI 自动跟随，无需改 UI 代码。

### 方案总览与事件顺序（所有者标注）

```
主模型 ── Agent tool call ──▶ call-runner (core/tool)
                                ▼
                  subagentPort.launch (core/runtime/methods/subagent.ts，owner: runtime)
                                ▼
                  runExploreAgent → child 轮次 (core/subagent/runner.ts，owner: subagent)
                                ▼
                  runAgentToCompletion (runner.ts:1116，注入点)
                    ├─ 全文 ≤ 32KB ──▶ 现状不变，原样组装 output
                    └─ 全文 > 32KB ──▶ result-digest 模块（新增，owner: subagent）
                         ├─ 全文 → artifactStore 落盘（session 保留期）→ fullOutputPath
                         └─ runResultDigest 回调（subagent.ts 注入，复用
                            runCompactSummaryModelRequest + child 模型）
                              ├─ 成功 → output.digest = { text, originalBytes, fullOutputPath }
                              └─ 失败/超时(60s)/空文本 → 不设 digest 字段，与现状逐字节一致 + warn 日志
                                ▼
                  serializeOutput (core/tool/executor，owner: tool)
                    ├─ formatAgentOutputForModel：有 digest → 摘要 + 路径行 + usage；无 → 全文
                    └─ 现有 120KB artifact 兜底通道原样保留（双保险）
                        ▼
        ┌───────────────────┴────────────────────┐
   前台路径                                  后台路径
   tool_result 进主上下文；                  finalizeBackgroundCompletion →
   UI 经 modelContent 自动展示摘要           formatLocalAgentTaskNotification：
                                            有 digest → <result> 用摘要；无 → 现状全文
```

### 设计决策（已与用户确认）

- **默认开启**，阈值 `thresholdBytes = 32_000`；逃生门 `ZCODE_SUBAGENT_RESULT_DIGEST=off`（bootstrap 读 env → config）。
- **全文存档**：digest 生成时全文写入 artifactStore（retention "session"），摘要尾部附 `full report: <path>` 行，模型与用户均可追溯。
- `output.content` **保持全文不变**（其他消费者零影响），digest 是新增可选字段。

### 改动清单

1. **Spec 先行**：新建 `specs/subagent-result-digest.md`，按现有模板写产品规则、状态所有者与不变量（digest 只在 runner 组装期生成一次、content 恒为全文、失败回退不变量）、失败语义、验收场景。
2. **contracts**（`packages/contracts/src/tools/agent.ts`）：`AgentCompletedOutput` 接口与 zod strict schema 新增可选 `digest: { text: string; originalBytes: number; fullOutputPath: string }`。
3. **core 新模块** `core/subagent/result-digest.ts`：阈值判定、digest prompt（保留原文语言；结构：任务结论→关键发现/改动（含具体文件路径与数值）→注意事项/后续；目标 ≤4000 字符，硬截断 6KB 兜底；禁止编造，精确标识符原样保留）、`<summary>` 提取（复用 compact/prompt.ts 的模式）。
4. **runner**（`core/subagent/runner.ts` 的 `runAgentToCompletion`）：拿到 `childResult.response` 后做阈值判定与 digest 调用（port options 新增 `artifactStore`、`resultDigest` 配置、`runResultDigest` 回调）。
5. **subagent.ts**（`core/runtime/methods/subagent.ts`）：实现 `runResultDigest`（复用 `runCompactSummaryModelRequest`，用 child 已解析的 Model，maxOutputTokens 2048，60s 超时回退），把 config/artifactStore 注入 port。
6. **agent.ts**（`core/tool/handlers/agent.ts`）：`AGENT_TOOL_OUTPUT_SCHEMA` 补 digest 属性（additionalProperties:false 必须同步）；`formatAgentOutputForModel` 有 digest 时输出摘要+路径+usage；工具描述补一句「超大结果会以摘要返回、全文有存档路径」。
7. **notification.ts**（`core/runtime-task/notification.ts`）：`formatLocalAgentTaskNotification` / 其输入构造优先用 digest 文本。
8. **配置**：`core/runtime/types.ts` 的 `AgentRuntimeConfig.subagents` 加 `resultDigest?: { enabled?: boolean; thresholdBytes?: number }`；bootstrap 读取 env 并注入（参照 `dynamicWorkflowEnabled` 的灰度门模式）。
9. **不改**：UI（零改动，自动跟随）；`SubmitResult`/`RespondToCoordinator`（不同语义，本期不动）；自定义 markdown profile 不强制追加 epilogue（后续项）。

### 测试计划（core 包首次建立测试）

`apps/zcode-cli/packages/core/test/`（node:test + node:assert/strict，参照 relay 样板），core package.json 新增 `"test": "tsx --test test/*.test.ts"`（tsx 加入 devDependencies）：

- `result-digest.test.ts`：阈值边界（32KB 上下各一例）；digest 成功时 output 带 digest 且 content 仍为全文；digest 失败/超时/空文本回退（无 digest 字段）；digest 超长硬截断。
- `agent-output-format.test.ts`：`formatAgentOutputForModel` 有 digest → 摘要+路径+usage、不含全文；无 digest → 输出与现状一致（防回归）。
- `notification-digest.test.ts`：后台通知 `<result>` 优先 digest、无 digest 时全文路径不变、120KB truncate 仍生效。
- schema 回环：`AgentCompletedOutputSchema.parse` 接受新字段、拒绝未知字段（strict 语义保持）。

### 验证步骤

1. `node scripts/check-workspace-freshness.mjs` 确认基线；
2. 按 `.agents/skills/architecture-governance` 运行 `pnpm architecture:check --changed`（新代码全部落在 core 包内，不引入 adapters 反向依赖，单文件 ≤400 行）；
3. `pnpm typecheck`、`pnpm lint`；
4. `pnpm --dir apps/zcode-cli/packages/core test` 实际执行新测试；
5. 构建 core（`pnpm --filter` 对应包 build）确认可编译。
6. 保留工作区已有无关改动（`packages/ui/src/WorkspaceSidebarItem.tsx`）不触碰。

### 风险与边界

- 摘要调用增加大结果场景 ~2-5s 延迟（仅 >32KB 时触发，可 env 关闭）；
- 摘要质量依赖 prompt，首次上线以「失败回退安全」为底线，摘要质量迭代靠后续轨迹回放 eval；
- 全文 artifact 为 session 保留期，会话清理后不可追溯（与现状 120KB 落盘行为一致）。