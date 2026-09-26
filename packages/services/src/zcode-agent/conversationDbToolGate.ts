// 会话级数据源门控（specs/data-source.md §7）的纯裁决函数。
//
// 规则：新建对话默认未选择数据源；未携带 dataSourceId 的对话轮对模型隐藏 DB 工具
// （提权），携带则当轮起可用。裁决只发生在 Host 信封装配处（桌面 / Web 同源），
// CLI 侧只机械执行既有 toolDisallowlist → prompt turn → turn-loop 管道。
//
// 工具名按名收口：宿主不能反向依赖 CLI 的 @zcode/contracts，与
// apps/zcode-cli/packages/contracts/src/tools/db.ts 的常量保持一致；CLI 侧
// 增删 DB 工具时必须同步此列表。

/** 与 apps/zcode-cli/packages/contracts/src/tools/db.ts 的 DB 四工具名一一对应。 */
export const CONVERSATION_DB_TOOL_NAMES: readonly string[] = [
  "DBQuery",
  "DBSchema",
  "DBExecute",
  "DBExport",
];

interface DataSourceBoundFirstInput {
  dataSourceId?: string;
  toolDisallowlist?: readonly string[];
}

/**
 * createSession.firstInput 的首发轮门控：未绑定数据源且调用方未自带名单时，
 * 注入 DB 工具禁用名单；已绑定或已自带（不覆盖调用方策略）时原样返回同一引用。
 */
export function mergeFirstInputDbToolGate<T extends DataSourceBoundFirstInput>(firstInput: T): T {
  if (firstInput.dataSourceId || firstInput.toolDisallowlist) return firstInput;
  return { ...firstInput, toolDisallowlist: [...CONVERSATION_DB_TOOL_NAMES] };
}

/**
 * sendText 的轮级门控：未绑定数据源 → 把 DB 工具并入轮级禁用名单（不覆盖既有名单）；
 * 已绑定 → 原名单透传（undefined 表示无需改写 payload）。
 */
export function mergeSendTextDbToolGate(
  toolDisallowlist: readonly string[] | undefined,
  dataSourceId: string | undefined,
): readonly string[] | undefined {
  if (dataSourceId) return toolDisallowlist;
  return [...(toolDisallowlist ?? []), ...CONVERSATION_DB_TOOL_NAMES];
}
