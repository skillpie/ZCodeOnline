# Spec: Subagent 结果摘要化（result digest）

> 实现入口：`apps/zcode-cli/packages/core/src/subagent/result-digest.ts`（决策与格式化）、
> `apps/zcode-cli/packages/core/src/subagent/runner.ts`（`runAgentToCompletion` 组装期接入）、
> `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`（模型回调注入）、
> `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`（模型可见面）、
> `apps/zcode-cli/packages/contracts/src/tools/agent.ts`（payload schema）。

## 1. 产品规则

- Subagent 完成后，最终报告默认**全文**回传主 agent（现状保持）；仅当报告字节数**严格大于**阈值（默认 `32_000` UTF-8 字节）时，生成一次摘要（digest），模型可见面与 UI 展示面改用 digest。
- `AgentCompletedOutput.content` **恒为全文**，digest 是新增可选字段 `digest: { text, originalBytes, fullOutputPath }`；摘要只改变消费方（`formatAgentOutputForModel`、后台 task-notification）读取的字段，不改写全文。
- digest 生成时，全文先写入 `ToolArtifactStorePort`（retention `session`）；`fullOutputPath` 优先取 artifact 落盘路径（缺省回退 `uri`，再回退 lifecycle `outputFile`）。摘要尾部附带 `full_report: <path> (original N KB)` 引用行，供模型与用户按需取回全文。
- digest 摘要保留报告原文语言；结构为：结论段 → 关键发现/改动（保留精确文件路径、命令、标识符与数值）→ 注意事项/后续；目标 ≤4000 字符，硬截断 6000 字节并追加截断标记。
- 配置：`AgentRuntimeConfig.subagents.resultDigest: { enabled?: boolean; thresholdBytes?: number }`，缺省 `{ enabled: true, thresholdBytes: 32_000 }`。env 逃生门 `ZCODE_SUBAGENT_RESULT_DIGEST=off|false|0` 强制关闭，优先于 config。
- digest 使用的模型为本次 Agent 调用继承的执行模型（`SubagentRunOptions.model`）；仅完成一次调用，`maxOutputTokens` 2048，超时 60s。

## 2. 状态所有者与不变量

- **所有者**：digest 决策与产物由 `core/subagent` 模块唯一拥有（`result-digest.ts` 纯逻辑 + runner 组装期一次性生成）；`core/tool`（agent handler）与 `core/runtime-task`（通知格式化）只消费，不重复生成。
- 生成时机唯一：`runAgentToCompletion` 拿到 child 最终报告之后、组装 `AgentCompletedOutput` 之前，前台与后台（含前台转后台）共用同一产物，不二次摘要。
- 不变量：
  - `content` 恒为全文；`digest.text` 永远是全文的子集语义（不得引入全文之外的信息）。
  - `digest` 存在 ⇒ 必有 `fullOutputPath`（artifact 或 lifecycle 输出文件）。
  - 摘要失败（模型失败/超时/空文本）⇒ 输出对象**不含** `digest` 字段，所有消费方行为与无摘要完全一致。
  - 工具结果回传预算（`resultBudget` 120KB artifact 兜底通道）保持不变，作为摘要失效时的第二道防线。

## 3. 失败语义

| 失败点                                 | 行为                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 配置关闭 / 报告 ≤ 阈值                 | 不生成 digest，不写 artifact，不调用模型，现状行为                                                             |
| artifact 写入失败                      | `fullOutputPath` 回退 lifecycle `outputFile`；不阻断 digest                                                    |
| 摘要模型调用失败 / 超时（60s）/ 返回空 | 记 warn 日志，不设 `digest` 字段，行为与现状逐字节一致                                                         |
| 摘要超长（>6000 字节）                 | 硬截断并追加 `[digest truncated]` 标记                                                                         |
| digest 存在时的渲染                    | `formatAgentOutputForModel` 与后台通知 `<result>` 均使用 digest + `full_report` 引用行；`<usage>` 统计保持原文 |

## 4. 验收场景

1. 报告 31_000 字节：模型可见面为全文，无 digest 字段，无模型摘要调用。
2. 报告 40_000 字节 + 摘要成功：`formatAgentOutputForModel` 输出含摘要文本与 `full_report:` 行、`<usage>` 统计，且不含全文任何片段；`AgentOutputSchema.parse` 通过；artifact store 收到全文写入请求（retention session）。
3. 报告 40_000 字节 + 摘要模型抛错：输出与场景 1 一致（含全文），仅多一条 warn 日志。
4. `ZCODE_SUBAGENT_RESULT_DIGEST=off` 时，任意大小报告都不触发摘要。
5. 后台 agent 完成通知：有 digest 时 `<result>` 为摘要 + 引用行；无 digest 时为全文 join，120KB 通知截断逻辑保持生效。
6. 摘要模型返回带 `<summary>` 包裹的文本：只取 `<summary>` 内内容；空 `<summary>` 视为失败回退。
