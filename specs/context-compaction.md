# Spec: 会话上下文压缩（microcompact artifact 指针保留）

## 行为

- 会话上下文压缩分三层：microcompact（局部清理工具结果，不调模型）、auto compact（接近阈值时
  单次模型调用生成摘要）、reactive compact（provider 溢出错误后兜底压缩并重试）。本文约束
  microcompact 的清理占位规则，其余层见 `apps/zcode-cli/packages/core/src/compact/` 与
  `runtime/methods/compact.ts`。
- microcompact 清理旧工具结果时，正文替换为占位符。若被清理的结果携带 artifact 落盘路径，
  占位符必须保留该路径指针，保证模型在清理后仍能通过 Read 等工具回读完整输出：
  - persisted-output 信封格式（`<persisted-output>`，见 `tool/result-persistence-format.ts`，
    Bash 大输出 artifact 策略使用）→ 占位符第二行保留 `Full output saved to: <path>`；
  - resultBudget 通用截断尾注（`[Tool output truncated by resultBudget: artifactPath=<path>, …]`，
    见 `tool/executor/result-serialization.ts`）→ 同样保留该路径。
- 不携带 artifact 路径的结果，占位符维持原样 `[Old tool result content cleared]`，行为不变。
- 已清理内容（含带指针变体）按占位符前缀识别，不再进入候选集，保证清理幂等且指针不被二次剥离。
- 错误结果、含 image/video/file 媒体块的结果仍受既有保护规则约束，不参与清理。

## 所有者与边界

- 策略所有者：`apps/zcode-cli/packages/core/src/compact/microcompact.ts`
  （触发阈值、可清理工具名单、保留组数、最小节省 token 均在此定义）。
- artifact 路径的唯一事实来源是工具结果文本本身（落盘格式由 tool 层写入）；microcompact 只做
  受格式门槛约束的文本提取，不做自由文本猜测，不引入对 tool 层内部实现之外的依赖。
- 运行时入口 `runtime/helpers/compact.ts` 负责 copy-on-write 回写消息历史，占位内容以 provider
  消息投影为准，本规则不改变该链路。

## 验收

1. 清理携带 persisted-output 信封的旧 Bash 结果后，占位内容包含原 artifact 路径
   （`Full output saved to: <path>` 行）。
2. 清理携带 resultBudget 截断尾注（含 artifactPath）的旧结果后，占位内容保留该路径。
3. 清理普通文本结果后，占位内容与原常量完全一致（向后兼容）。
4. 对已清理结果（含带指针变体）重复执行 microcompact，不再产生候选（nothing_to_clear）。
5. 保留最近 N 组、最小节省 token、媒体与错误保护等既有行为不回归。
