import type {
  ExtensionApi,
  ExtensionDiagnostic,
  ExtensionEventHandler,
  ExtensionEventHandlerOptions,
  ExtensionHookRunnerInput,
  ExtensionLoadOutcome,
  ExtensionSetup,
  ExtensionToolDefinition,
  LoadExtensionsOptions,
  LoadedExtensionSummary,
} from "./contract.js";

export type {
  ExtensionApi,
  ExtensionDiagnostic,
  ExtensionEventHandler,
  ExtensionEventHandlerOptions,
  ExtensionHookRunnerInput,
  ExtensionLoadOutcome,
  ExtensionSetup,
  ExtensionToolDefinition,
  LoadExtensionsOptions,
  LoadedExtensionSummary,
};

/** 加载 extension 目录并映射成宿主注入物（ToolEntry / HookRegistration）。 */
export { loadExtensions } from "./module.js";

/** 组装 configured + extension 的合并 hook runner，经 `deps.hookRunner` 注入。 */
export { createExtensionAwareHookRunner } from "./module.js";
