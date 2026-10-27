// ============================================================
// Extension Host Contract - 进程内 TS extension 的公开 API 面
// ============================================================
//
// 设计约束（fork 策略）：本模块是 extension 能力的唯一宿主面。所有接缝都
// 走 core 已公开的注入点（`AgentRuntimeDeps.toolRegistry` / `.hookRunner`）
// 与既有工厂（`createToolRegistry` / `createConfiguredHookRunner` /
// `createInMemoryHookRunner`），不改 core 任何文件——上游合并的冲突面因此
// 收敛在 bootstrap 装配行的个位数 diff。模型请求路径事件（context /
// before_provider_request）、TUI 组件与 provider 注册刻意不进 v1。

import type {
  ExecutionPort,
  HookEventName,
  HookInput,
  HookJSONOutput,
  HooksRuntimeConfig,
  JsonSchema,
  Logger,
  ModelToolSideEffectScope,
  RiskLevel,
  SessionEvent,
  WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import type {
  HookRegistration,
  HookRunner,
  ToolEntry,
  ToolExecutionContext,
  WorkspaceHookRuntimeAdmissionPort,
} from "@zcode/core";

// -----------------------------------------------
// Extension Authoring API（extension 作者可见）
// -----------------------------------------------

/**
 * extension 注册一个模型可调用工具。缺省元数据取**安全默认**：非只读工具
 * 一律 needsApproval（审批面板出场）、不得进入 plan mode、风险级别 medium。
 * 只读工具才允许缺省免审批。扩展工具与内置工具重名时内置工具在后注册覆盖，
 * 这里只发 diagnostic 提示作者改名。
 */
export interface ExtensionToolDefinition {
  /** 模型可见工具名。约定带扩展名前缀（如 `myext_lookup`）；禁止 `mcp__` 前缀。 */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown>;
  /** 缺省 false。true 才允许缺省免审批与进入 plan mode 推导。 */
  readOnly?: boolean;
  destructive?: boolean;
  /** 缺省与 readOnly 一致：只读工具可安全并发。 */
  concurrentSafe?: boolean;
  /** 缺省强制 true（非只读时）。显式 false 视为作者自担风险，仍然记录 warning。 */
  needsApproval?: boolean;
  riskLevel?: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  allowedInPlanMode?: boolean;
  aliases?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type ExtensionEventHandler = (
  input: HookInput,
) => HookJSONOutput | void | Promise<HookJSONOutput | void>;

export interface ExtensionEventHandlerOptions {
  matcher?: string;
  timeoutMs?: number;
}

/**
 * extension setup 函数拿到的宿主 API。v1 只有两个动词：`tool`（注册进程内
 * 工具）与 `on`（订阅 hook 生命周期事件）。事件集 = hooks 已有六事件，进程内
 * 回调，不经 shell、不落 workspace-hook 信任审核（加载即信任，见 CONTRACT.md）。
 */
export interface ExtensionApi {
  tool(definition: ExtensionToolDefinition): void;
  on(
    event: HookEventName,
    handler: ExtensionEventHandler,
    options?: ExtensionEventHandlerOptions,
  ): void;
  log: Logger;
}

export type ExtensionSetup = (api: ExtensionApi) => void | Promise<void>;

// -----------------------------------------------
// Load Outcome（宿主装配可见）
// -----------------------------------------------

export interface ExtensionDiagnostic {
  code:
    | "extension_load_failed"
    | "extension_invalid_export"
    | "extension_tool_invalid"
    | "extension_tool_name_conflict"
    | "extension_event_invalid"
    | "extension_loader_unavailable"
    | "extension_project_dir_skipped";
  message: string;
  path: string;
  extensionId?: string;
  severity: "error" | "warning" | "info";
}

export interface LoadedExtensionSummary {
  /** 稳定 id：来源目录内相对路径（如 `my-ext/index.ts`）。 */
  id: string;
  path: string;
  origin: "user" | "project";
  tools: string[];
  events: HookEventName[];
}

export interface ExtensionLoadOutcome {
  extensions: LoadedExtensionSummary[];
  /** 已映射成宿主 ToolEntry 的扩展工具；经 `deps.toolRegistry` 注入 runtime。 */
  toolEntries: ToolEntry[];
  /** 已映射成宿主 HookRegistration 的事件订阅；经 `deps.hookRunner` 注入 runtime。 */
  hookRegistrations: HookRegistration[];
  diagnostics: ExtensionDiagnostic[];
}

export interface LoadExtensionsOptions {
  /** 用户级扩展目录；缺省 `<home>/.zcode/extensions`。 */
  homeDirectory?: string;
  /**
   * 额外受信目录（显式授权即信任）。v1 的项目级扩展必须经此显式列出：
   * 进程内代码权限等于宿主，不做「工作区里存在即加载」的隐式信任；
   * 信任审核 UI 属 Phase 3。
   */
  extraDirectories?: readonly string[];
  workingDirectory?: string;
  logger?: Logger;
  /** 总开关。缺省读 `ZCODE_DISABLE_EXTENSIONS=1`。 */
  disabled?: boolean;
}

// -----------------------------------------------
// Hook Runner Assembly（bootstrap 装配可见）
// -----------------------------------------------

export interface ExtensionHookRunnerInput {
  /** runtime 配置里的 shell hooks 配置；与 core `runtime-tools.ts` 的门控同源。 */
  hooksRuntimeConfig?: HooksRuntimeConfig;
  executionPort?: ExecutionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  getWorkingDirectory: () => string;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  logger?: Logger;
  registrations: HookRegistration[];
}

// `loadExtensions` / `createExtensionAwareHookRunner` 的实现与出口见 module.ts / index.ts。
