import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createExtensionAwareHookRunner,
  loadExtensions,
} from "../../src/extension-host/index.js";
import type { ExtensionSetup } from "../../src/extension-host/index.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createExtensionDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ext-"));
  cleanup.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return dir;
}

const BASE_OPTIONS = {
  // 隔离用户级目录：HOME 指向不存在的路径，用户目录扩展不会串进用例。
  homeDirectory: join(tmpdir(), "zcode-ext-no-home"),
  disabled: false,
};

const SETUPS: Record<string, string> = {
  "demo.ts": `
    export default function (api) {
      api.tool({
        name: "ext_lookup",
        description: "lookup",
        inputSchema: { type: "object", properties: { key: { type: "string" } } },
        async execute(input) { return { key: input.key }; },
      });
      api.on("SessionStart", async () => ({ additionalContext: "hello-from-extension" }));
    }
  `,
};

it("加载扩展并应用安全默认：非只读工具强制审批、禁入 plan mode", async () => {
  const dir = await createExtensionDir(SETUPS);
  const outcome = await loadExtensions({ ...BASE_OPTIONS, extraDirectories: [dir] });

  expect(outcome.diagnostics).toEqual([]);
  expect(outcome.extensions).toHaveLength(1);
  expect(outcome.extensions[0]).toMatchObject({ id: "demo.ts", origin: "project", tools: ["ext_lookup"] });

  const entry = outcome.toolEntries.find((candidate) => candidate.metadata.name === "ext_lookup");
  expect(entry).toBeDefined();
  expect(entry?.metadata).toMatchObject({
    readOnly: false,
    needsApproval: true,
    riskLevel: "medium",
    sideEffectScope: "workspace",
    allowedInPlanMode: false,
    concurrentSafe: false,
  });
  expect(entry?.timeout).toMatchObject({ kind: "timed", allowCallOverride: true });
  expect(entry?.cancellation).toMatchObject({ supported: false });

  const registration = outcome.hookRegistrations[0];
  expect(registration).toMatchObject({
    event: "SessionStart",
    source: "extension:demo.ts",
    sourceKind: "project",
  });
  // 不设 async:true：进程内回调必须走同步结果路径，fire-and-forget 会丢输出。
  expect(registration?.async).toBeUndefined();
  expect(typeof registration?.callback).toBe("function");
});

it("只读工具的缺省元数据免审批且可并发", async () => {
  const dir = await createExtensionDir({
    "ro.ts": `
      export default function (api) {
        api.tool({
          name: "ext_read",
          description: "read only",
          inputSchema: { type: "object" },
          readOnly: true,
          async execute() { return {}; },
        });
      }
    `,
  });
  const outcome = await loadExtensions({ ...BASE_OPTIONS, extraDirectories: [dir] });
  expect(outcome.toolEntries[0]?.metadata).toMatchObject({
    readOnly: true,
    needsApproval: false,
    riskLevel: "low",
    sideEffectScope: "none",
    concurrentSafe: true,
  });
});

it("项目扩展目录不隐式加载：发现即提示显式授权（信任拒绝路径）", async () => {
  const workingDirectory = await createExtensionDir({
    ".zcode/extensions/secret.ts": "export default function (api) { api.tool({ name: 'ext_no', description: 'x', inputSchema: { type: 'object' }, async execute() { return {}; } }); }",
  });
  const outcome = await loadExtensions({ ...BASE_OPTIONS, workingDirectory });

  expect(outcome.extensions).toEqual([]);
  expect(outcome.toolEntries).toEqual([]);
  expect(outcome.diagnostics).toHaveLength(1);
  expect(outcome.diagnostics[0]).toMatchObject({
    code: "extension_project_dir_skipped",
    severity: "info",
  });
});

it("kill switch 生效：disabled 时不读任何目录", async () => {
  const dir = await createExtensionDir(SETUPS);
  const outcome = await loadExtensions({ ...BASE_OPTIONS, extraDirectories: [dir], disabled: true });
  expect(outcome.extensions).toEqual([]);
  expect(outcome.diagnostics).toEqual([]);
});

it("非函数导出与 setup 抛错都隔离成 diagnostic，且不留半个扩展", async () => {
  const dir = await createExtensionDir({
    "bad-export.js": "module.exports = 42;",
    "throws.ts": `
      export default function (api) {
        api.tool({
          name: "ext_partial",
          description: "registered before the crash",
          inputSchema: { type: "object" },
          async execute() { return {}; },
        });
        throw new Error("setup exploded");
      }
    `,
  });
  const outcome = await loadExtensions({ ...BASE_OPTIONS, extraDirectories: [dir] });

  expect(outcome.extensions).toEqual([]);
  expect(outcome.toolEntries).toEqual([]);
  const codes = outcome.diagnostics.map((diagnostic) => diagnostic.code).sort();
  expect(codes).toEqual(["extension_invalid_export", "extension_load_failed"]);
});

it("保留前缀与内置工具冲突分别产出错误与 warning", async () => {
  const dir = await createExtensionDir({
    "names.ts": `
      export default function (api) {
        api.tool({
          name: "mcp__forbidden",
          description: "reserved prefix",
          inputSchema: { type: "object" },
          async execute() { return {}; },
        });
        api.tool({
          name: "Bash",
          description: "collides with built-in",
          inputSchema: { type: "object" },
          async execute() { return {}; },
        });
      }
    `,
  });
  const outcome = await loadExtensions({ ...BASE_OPTIONS, extraDirectories: [dir] });

  expect(outcome.toolEntries.map((entry) => entry.metadata.name)).toEqual(["Bash"]);
  const codes = outcome.diagnostics.map((diagnostic) => diagnostic.code).sort();
  expect(codes).toEqual(["extension_tool_invalid", "extension_tool_name_conflict"]);
});

it("合并 runner 真实运行扩展回调：additionalContext 进入 hook 结果", async () => {
  const dir = await createExtensionDir(SETUPS);
  const outcome = await loadExtensions({ ...BASE_OPTIONS, extraDirectories: [dir] });
  expect(outcome.hookRegistrations.length).toBeGreaterThan(0);

  const runner = createExtensionAwareHookRunner({
    getWorkingDirectory: () => tmpdir(),
    registrations: outcome.hookRegistrations,
  });
  expect(runner).toBeDefined();

  const result = await runner!.run(
    {
      cwd: tmpdir(),
      hookEventName: "SessionStart",
      mode: "build",
      sessionId: "session-extension-test",
      timestamp: new Date().toISOString(),
      traceId: "trace-extension-test",
    } as Parameters<typeof runner.run>[0],
  );
  expect(result.additionalContexts).toContain("hello-from-extension");
});

it("无扩展订阅时返回 undefined，runtime 走 core 自建路径（行为零漂移）", () => {
  const runner = createExtensionAwareHookRunner({
    getWorkingDirectory: () => tmpdir(),
    registrations: [],
  });
  expect(runner).toBeUndefined();
});

it("example 扩展满足宿主 API 契约（setup 可执行且注册形状正确）", async () => {
  const { exampleExtensionSetup } = await import("../../src/extension-host/contract.example.js");
  const tools: unknown[] = [];
  const events: string[] = [];
  const api = {
    tool: (definition: unknown) => tools.push(definition),
    on: (event: string) => events.push(event),
    log: { info: () => {} },
  };
  await exampleExtensionSetup(api as Parameters<ExtensionSetup>[0]);
  expect(tools).toHaveLength(1);
  expect(events).toEqual(["SessionStart"]);
});

it("模块清单与 architecture-policy 登记一致", async () => {
  const { cliExtensionHostModule } = await import("../../src/extension-host/module.js");
  expect(cliExtensionHostModule.id).toBe("cli-extension-host");
  expect(cliExtensionHostModule.requires).toEqual(["zcode-cli"]);
});
