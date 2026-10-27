// ============================================================
// Extension Host - 发现、加载（jiti）与宿主映射
// ============================================================
//
// 职责边界：本模块把磁盘上的 TS/JS extension 映射成 core 已有的两种宿主
// 注入物——`ToolEntry`（经 `AgentRuntimeDeps.toolRegistry`）与
// `HookRegistration`（经 `AgentRuntimeDeps.hookRunner`）。不改 core、不新增
// 执行路径：进程内回调复用 `InMemoryHookRunner.register()`（session-mailbox
// 同一条先例），工具复用现有注册表与权限元数据推导。

import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { Jiti } from "jiti";
import {
  HookEventName as HookEventNameValue,
  type HookEventName,
  type HooksRuntimeConfig,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import {
  builtInTools,
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  type HookRegistration,
  type HookRunner,
  type ToolEntry,
  type WorkspaceHookRuntimeAdmissionPort,
} from "@zcode/core";
import type {
  ExtensionApi,
  ExtensionDiagnostic,
  ExtensionEventHandlerOptions,
  ExtensionHookRunnerInput,
  ExtensionLoadOutcome,
  ExtensionSetup,
  ExtensionToolDefinition,
  LoadExtensionsOptions,
  LoadedExtensionSummary,
} from "./contract.js";

// 与 core `runtime-tools.ts` 的 EMPTY_RUNTIME_HOOK_CONFIG 同源同值；
// 上游若调整默认值，这里必须跟随（镜像点已在两处注释互指）。
const EMPTY_RUNTIME_HOOK_CONFIG: HooksRuntimeConfig = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
};

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ENTRY_FILE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);

// -----------------------------------------------
// Discovery
// -----------------------------------------------

interface ExtensionSourceDirectory {
  path: string;
  origin: "user" | "project";
}

function resolveExtensionDirectories(options: LoadExtensionsOptions): ExtensionSourceDirectory[] {
  const home = options.homeDirectory ?? process.env.HOME ?? process.env.USER_PROFILE;
  const directories: ExtensionSourceDirectory[] = [];
  if (home) {
    directories.push({ path: join(home, ".zcode", "extensions"), origin: "user" });
  }
  // 显式授权目录优先取 options，缺省回落环境变量（路径分隔符分隔）。
  // 授权即信任：这里的每个路径都等价于「用户明确愿意让这段代码全权运行」。
  const extra =
    options.extraDirectories ??
    (process.env.ZCODE_EXTENSIONS_EXTRA_DIRS ?? "")
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  for (const path of extra) {
    directories.push({ path: resolve(path), origin: "project" });
  }
  return directories;
}

async function resolveExtensionEntryPaths(
  directory: ExtensionSourceDirectory,
): Promise<{ entryPath: string; id: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(directory.path);
  } catch {
    // 目录不存在 = 无扩展，属正常形态，不算 diagnostic。
    return [];
  }
  const resolved: { entryPath: string; id: string }[] = [];
  for (const name of entries.sort()) {
    const fullPath = join(directory.path, name);
    const info = await stat(fullPath).catch(() => undefined);
    if (info?.isDirectory()) {
      for (const extension of ENTRY_FILE_EXTENSIONS) {
        const indexPath = join(fullPath, `index${extension}`);
        if (await stat(indexPath).then(() => true).catch(() => false)) {
          resolved.push({ entryPath: indexPath, id: `${name}/index${extension}` });
          break;
        }
      }
      continue;
    }
    if (info?.isFile() && ENTRY_FILE_EXTENSIONS.has(basename(name).match(/\.[^.]+$/)?.[0] ?? "")) {
      resolved.push({ entryPath: fullPath, id: name });
    }
  }
  return resolved;
}

// -----------------------------------------------
// Loading & API mapping
// -----------------------------------------------

interface ExtensionCollector {
  tools: ExtensionToolDefinition[];
  registrations: Omit<HookRegistration, "callback">[];
  rawCallbacks: Map<string, HookRegistration["callback"]>;
  events: HookEventName[];
}

function createExtensionApi(input: {
  id: string;
  origin: "user" | "project";
  logger: Logger | undefined;
  collector: ExtensionCollector;
  diagnostics: ExtensionDiagnostic[];
}): ExtensionApi {
  const log = input.logger ?? silentLogger;
  return {
    log: log,
    tool(definition) {
      const failure = validateToolDefinition(definition);
      if (failure !== undefined) {
        input.diagnostics.push({
          code: "extension_tool_invalid",
          message: failure,
          path: input.id,
          extensionId: input.id,
          severity: "error",
        });
        return;
      }
      input.collector.tools.push(definition);
    },
    on(event, handler, handlerOptions) {
      if (!Object.values(HookEventNameValue).includes(event)) {
        input.diagnostics.push({
          code: "extension_event_invalid",
          message: `Unsupported hook event: ${String(event)}`,
          path: input.id,
          extensionId: input.id,
          severity: "error",
        });
        return;
      }
      input.collector.events.push(event);
      const index = input.collector.registrations.length;
      input.collector.registrations.push({
        event,
        matcher: handlerOptions?.matcher,
        timeoutMs: handlerOptions?.timeoutMs,
        // 不设 async:true：async 会进入 fire-and-forget 后台路径，输出不进
        // 同步 HookRunResult（core hooks/runner.ts「输出不得反向改变已经继续
        // 执行的动作」）。进程内回调本来就在宿主里，走同步路径并受
        // runCallbackWithTimeout 的超时保护，语义等同 shell hook。
        source: `extension:${input.id}`,
        sourceKind: input.origin,
      });
      // callback 与注册体分开存：注册体进入 outcome，callback 在 setup 成功
      // 结束后才补齐——setup 抛错时整个扩展的订阅一并丢弃，不留半个扩展。
      input.collector.rawCallbacks.set(`${event}:${index}`, (hookInput) => {
        return Promise.resolve(handler(hookInput)).catch((error: unknown) => {
          log.warn(`Extension handler failed`, {
            event: "extension.host.handler_failed",
            extensionId: input.id,
            hookEvent: String(event),
            error: error instanceof Error ? error.message : String(error),
          });
          // 回调失败不产生 hook 决策：与 shell hook 的非零退出语义一致（不阻断）。
          return undefined;
        });
      });
    },
  };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function validateToolDefinition(definition: ExtensionToolDefinition): string | undefined {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    return `Invalid tool name: ${definition.name}`;
  }
  if (definition.name.startsWith("mcp__")) {
    return `Tool name must not use the reserved mcp__ prefix: ${definition.name}`;
  }
  if (typeof definition.execute !== "function") {
    return `Tool ${definition.name} is missing an execute function`;
  }
  if (!definition.inputSchema || typeof definition.inputSchema !== "object") {
    return `Tool ${definition.name} is missing an inputSchema`;
  }
  return undefined;
}

/**
 * 安全默认（CONTRACT.md「Defaults」）：非只读工具一律进审批面板、禁入 plan
 * mode、风险 medium、副作用域 workspace；只读工具才允许缺省免审批。
 * `needsApproval: false` 的显式声明允许但记 warning——作者自担风险要留痕。
 */
function toToolEntry(
  definition: ExtensionToolDefinition,
  extensionId: string,
  logger: Logger | undefined,
  diagnostics: ExtensionDiagnostic[],
): ToolEntry {
  const readOnly = definition.readOnly ?? false;
  const needsApproval = definition.needsApproval ?? !readOnly;
  if (definition.needsApproval === false) {
    logger?.warn(`Extension tool ${definition.name} explicitly opted out of approval`, {
      event: "extension.host.tool_no_approval",
      extensionId,
      toolName: definition.name,
    });
  }
  if (builtInTools.some((tool) => tool.metadata.name === definition.name)) {
    diagnostics.push({
      code: "extension_tool_name_conflict",
      message: `Extension tool ${definition.name} collides with a built-in tool; the built-in wins at runtime`,
      path: extensionId,
      extensionId,
      severity: "warning",
    });
  }
  const timeoutMs = definition.timeoutMs ?? 60_000;
  // resultBudget 对齐 db-query 同档（60KB 截断 + 头部预览）：扩展输出不可信
  // 其体积自律，必须进既有结果预算管线。
  const maxResultBytes = definition.maxOutputBytes ?? 60_000;
  return {
    capability: `Extension tool provided by ${extensionId}: ${definition.description}`,
    metadata: {
      name: definition.name,
      description: definition.description,
      readOnly,
      destructive: definition.destructive ?? false,
      concurrentSafe: definition.concurrentSafe ?? readOnly,
      sideEffectScope: definition.sideEffectScope ?? (readOnly ? "none" : "workspace"),
      riskLevel: definition.riskLevel ?? (readOnly ? "low" : "medium"),
      needsApproval,
      allowedInPlanMode: definition.allowedInPlanMode ?? false,
      providerVisible: true,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: definition.maxOutputBytes,
    },
    inputSchema: definition.inputSchema,
    outputSchema: { type: "object" },
    aliases: definition.aliases,
    permission: {
      // 扩展工具是独立权限族：规则可以用 "extension" 族引用全部扩展工具。
      permission: readOnly ? "read" : "extension",
      reason: `${needsApproval ? "Extension tool requires approval" : "Read-only extension tool"}: ${definition.name}`,
      riskLevel: definition.riskLevel ?? (readOnly ? "low" : "medium"),
      sideEffectScope: definition.sideEffectScope ?? (readOnly ? "none" : "workspace"),
      needsApproval,
      patternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: maxResultBytes,
      maxModelBytes: maxResultBytes,
      strategy: "truncate",
      preview: {
        maxBytes: Math.min(8_192, maxResultBytes),
        direction: "head",
      },
    },
    handler: async (input, context) => definition.execute(input, context),
    timeout: {
      kind: "timed",
      defaultMs: timeoutMs,
      allowCallOverride: true,
    },
    cancellation: {
      supported: false,
      cleanup: "none",
      userVisibleMessage: "Extension tools do not support cancellation",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      // 扩展代码不在宿主审计范围内，入参与输出只记摘要。
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

// -----------------------------------------------
// Module manifest
// -----------------------------------------------

/**
 * cli-extension-host 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliExtensionHostModule = {
  id: "cli-extension-host",
  requires: ["zcode-cli"],
  provides: ["cli-extension-host"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

// -----------------------------------------------
// Public entry: loadExtensions
// -----------------------------------------------

/**
 * jiti 加载器的解析锚点。刻意不依赖 import.meta：cjs 打包态下它是空对象
 * （见 loadExtensions 内注释）。argv[1] 缺席时退回 cwd 下的锚位文件——
 * createRequire/createJiti 只要求一个可定位的路径作解析起点。
 */
function resolveExtensionLoaderBase(): string {
  return process.argv[1] ?? join(process.cwd(), "index.js");
}

/**
 * 惰性解析 jiti。此前是顶层静态 `import { createJiti } from "jiti"`：
 * 桌面安装包里 electron-builder 会把 extraResources 根部的 node_modules
 * 按 desktop 生产依赖裁剪（jiti 不在其中），模块一加载就 MODULE_NOT_FOUND，
 * 直接拖死整个启动准备进程（2026-10-27 "Startup preparation failed /
 * transport_closed" 事故根因）。改为此处按候选路径解析：jiti 缺席时返回
 * undefined，扩展能力整体降级为一条诊断，绝不阻断应用启动。
 */
function loadJitiFactory(): ((base?: string) => Jiti) | undefined {
  const anchorBase = resolveExtensionLoaderBase();
  const anchorDir = dirname(anchorBase);
  const candidates = [
    // 常规解析：dev（仓库根 node_modules 提升安装）与 CLI 发行包（runtime/node_modules）。
    "jiti",
    // 桌面安装包：prepare-agent-node-bundle stage 到 glm/runtime-deps/jiti
    //（刻意避开 node_modules 命名，任何层级的裁剪都碰不到它）。
    resolve(anchorDir, "runtime-deps", "jiti", "lib", "jiti.cjs"),
    resolve(anchorDir, "node_modules", "jiti", "lib", "jiti.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      const mod = createRequire(anchorBase)(candidate) as {
        createJiti?: unknown;
      };
      if (typeof mod.createJiti === "function") {
        return mod.createJiti as (base?: string) => Jiti;
      }
    } catch {
      // 候选缺席，尝试下一个。
    }
  }
  return undefined;
}

export async function loadExtensions(
  options: LoadExtensionsOptions = {},
): Promise<ExtensionLoadOutcome> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const disabled = options.disabled ?? process.env.ZCODE_DISABLE_EXTENSIONS === "1";
  const logger = options.logger;

  const toolEntries: ToolEntry[] = [];
  const hookRegistrations: HookRegistration[] = [];
  const extensions: LoadedExtensionSummary[] = [];

  if (disabled) {
    return { extensions, toolEntries, hookRegistrations, diagnostics };
  }

  const jitiFactory = loadJitiFactory();
  if (jitiFactory === undefined) {
    // 可选能力缺席只能降级，不能让启动失败（见 loadJitiFactory 注释的事故）。
    logger?.warn("jiti is unavailable in this runtime; extensions are disabled", {
      event: "extension.host.loader_unavailable",
      anchor: resolveExtensionLoaderBase(),
    });
    diagnostics.push({
      code: "extension_loader_unavailable",
      message:
        "jiti could not be resolved from the runtime bundle; extension loading is disabled in this installation",
      path: resolveExtensionLoaderBase(),
      severity: "warning",
    });
    return { extensions, toolEntries, hookRegistrations, diagnostics };
  }
  const jiti = jitiFactory(resolveExtensionLoaderBase());

  const directories = resolveExtensionDirectories(options);
  if (options.workingDirectory !== undefined && options.extraDirectories === undefined) {
    // v1 信任模型：工作区扩展目录不做隐式加载。发现即提示显式授权路径，
    // Phase 3 的信任审核接手后这里会变成审核流入口。
    const projectDir = join(options.workingDirectory, ".zcode", "extensions");
    const exists = await stat(projectDir).then(() => true).catch(() => false);
    if (exists) {
      diagnostics.push({
        code: "extension_project_dir_skipped",
        message: `Project extensions require explicit trust; pass the directory via ZCODE_EXTENSIONS_EXTRA_DIRS to enable: ${projectDir}`,
        path: projectDir,
        severity: "info",
      });
    }
  }

  // 修复 esbuild cjs 打包态的 empty-import-meta：zcode.cjs 输出里 import.meta
  // 会被替换成空对象，import.meta.url 运行时为 undefined，jiti 的解析锚点随之
  // 失效。CLI 打包态入口在 process.argv[1]（zcode.cjs），与 official-plugin
  // runtime 的 officialPluginHostPrefixArgs 同一先例；扩展入口都是绝对路径，
  // 该锚点只服务裸说明符回退解析，三种运行形态（tsx / cjs / SEA）均可接受。
  // jiti 实例已在上方经 loadJitiFactory 惰性创建。

  for (const directory of directories) {
    const entryPaths = await resolveExtensionEntryPaths(directory);
    for (const { entryPath, id } of entryPaths) {
      const outcome = await loadSingleExtension(jiti, {
        entryPath,
        id,
        origin: directory.origin,
        logger,
      });
      extensions.push(...outcome.extensions);
      toolEntries.push(...outcome.toolEntries);
      hookRegistrations.push(...outcome.hookRegistrations);
      diagnostics.push(...outcome.diagnostics);
    }
  }

  return { extensions, toolEntries, hookRegistrations, diagnostics };
}

async function loadSingleExtension(
  jiti: Jiti,
  input: { entryPath: string; id: string; origin: "user" | "project"; logger: Logger | undefined },
): Promise<
  Pick<ExtensionLoadOutcome, "extensions" | "toolEntries" | "hookRegistrations"> & {
    diagnostics: ExtensionDiagnostic[];
  }
> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const fail = (code: ExtensionDiagnostic["code"], message: string): ExtensionDiagnostic => ({
    code,
    message,
    path: input.entryPath,
    extensionId: input.id,
    severity: "error",
  });

  let exported: unknown;
  try {
    const mod = (await jiti.import(input.entryPath)) as Record<string, unknown>;
    exported = typeof mod.default === "function" ? mod.default : mod;
  } catch (error) {
    return {
      extensions: [],
      toolEntries: [],
      hookRegistrations: [],
      diagnostics: [
        fail(
          "extension_load_failed",
          error instanceof Error ? error.message : `Failed to load extension: ${input.entryPath}`,
        ),
      ],
    };
  }
  if (typeof exported !== "function") {
    return {
      extensions: [],
      toolEntries: [],
      hookRegistrations: [],
      diagnostics: [
        fail("extension_invalid_export", "Extension must default-export a setup function"),
      ],
    };
  }

  const collector: ExtensionCollector = {
    tools: [],
    registrations: [],
    rawCallbacks: new Map(),
    events: [],
  };
  const api = createExtensionApi({
    id: input.id,
    origin: input.origin,
    logger: input.logger,
    collector,
    diagnostics,
  });

  try {
    await (exported as ExtensionSetup)(api);
  } catch (error) {
    return {
      extensions: [],
      toolEntries: [],
      hookRegistrations: [],
      diagnostics: [
        fail(
          "extension_load_failed",
          error instanceof Error ? error.message : `Extension setup failed: ${input.id}`,
        ),
      ],
    };
  }

  const toolEntries: ToolEntry[] = [];
  const seenToolNames = new Set<string>();
  for (const definition of collector.tools) {
    if (seenToolNames.has(definition.name)) {
      diagnostics.push(
        fail("extension_tool_invalid", `Duplicate tool name within extension: ${definition.name}`),
      );
      continue;
    }
    seenToolNames.add(definition.name);
    toolEntries.push(toToolEntry(definition, input.id, input.logger, diagnostics));
  }

  const hookRegistrations: HookRegistration[] = collector.registrations.map(
    (registration, index) => ({
      ...registration,
      callback: collector.rawCallbacks.get(`${registration.event}:${index}`)!,
    }),
  );

  return {
    extensions: [
      {
        id: input.id,
        path: input.entryPath,
        origin: input.origin,
        tools: toolEntries.map((entry) => entry.metadata.name),
        events: collector.events,
      },
    ],
    toolEntries,
    hookRegistrations,
    diagnostics,
  };
}

// -----------------------------------------------
// Public entry: createExtensionAwareHookRunner
// -----------------------------------------------

export function createExtensionAwareHookRunner(
  input: ExtensionHookRunnerInput,
): HookRunner | undefined {
  // 门控与构造镜像 core `runtime/helpers/runtime-tools.ts` 的
  // createRuntimeHookRunner：deps.hookRunner 在场时 core 会跳过自建路径，
  // 所以这里的 configured 构造必须与那条路径语义等价（含 EMPTY 默认值）。
  // 无扩展订阅时返回 undefined，让 core 走原路径，行为零漂移。
  if (input.registrations.length === 0) {
    return undefined;
  }

  const emitEvent =
    input.emitEvent ??
    (async (_event: SessionEvent) => {
      // 扩展专属 runner 的兜底：无事件汇时生命周期事件就地丢弃。
    });

  const configured =
    (input.hooksRuntimeConfig?.enabled || input.workspaceHookSnapshot) && input.executionPort
      ? createConfiguredHookRunner({
          config: input.hooksRuntimeConfig ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent,
          executionPort: input.executionPort,
          getWorkingDirectory: input.getWorkingDirectory,
          logger: input.logger,
          workspaceHookAdmission: input.workspaceHookAdmission,
          workspaceHookSnapshot: input.workspaceHookSnapshot,
        })
      : undefined;

  if (configured === undefined) {
    // 镜像 session-mailbox 分支：无 configured 时自建 InMemory runner 承接扩展注册。
    const runner = createInMemoryHookRunner({
      defaultTimeoutMs: EMPTY_RUNTIME_HOOK_CONFIG.timeoutMs,
      emitEvent,
      logger: input.logger,
    });
    for (const registration of input.registrations) {
      runner.register(registration);
    }
    return runner;
  }

  for (const registration of input.registrations) {
    // createConfiguredHookRunner 返回 InMemoryHookRunner 实例，register 在
    // 运行时必然存在；与 core runtime-tools.ts 的 session-mailbox 分支同款
    // 防御式收窄，HookRunner 接口本身不声明 register。
    if ("register" in configured && typeof configured.register === "function") {
      configured.register(registration);
    }
  }
  return configured;
}
