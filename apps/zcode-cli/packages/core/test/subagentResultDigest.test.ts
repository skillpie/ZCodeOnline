// specs/subagent-result-digest.md §4 验收场景的单元覆盖。
// 核心不变量：摘要失败 ⇒ 输出不含 digest，行为与无摘要完全一致；content 恒为全文。
import test from "node:test";
import assert from "node:assert/strict";
import type {
  AgentCompletedOutput,
  Logger,
  Model,
  ToolArtifactStorePort,
} from "@zcode/contracts";
import {
  MAX_SUBAGENT_RESULT_DIGEST_BYTES,
  formatSubagentResultDigestReference,
  maybeDigestSubagentResult,
  resolveSubagentNotificationResultText,
  resolveSubagentResultDigestConfig,
} from "../src/subagent/result-digest.js";
import { agentToolEntry } from "../src/tool/handlers/agent.js";

const stubModel = { providerId: "test", modelId: "test-model" } as Model;
const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

function fakeArtifactStore(overrides: Partial<ToolArtifactStorePort> = {}): ToolArtifactStorePort {
  return {
    writeToolResultArtifact: async () => ({
      id: "artifact-1",
      uri: "zcode-artifact://session/artifact-1",
      path: "/tmp/zcode-artifacts/artifact-1.md",
      bytes: 1,
      contentType: "text/markdown",
      createdAt: new Date(),
    }),
    readToolResultArtifact: async () => {
      throw new Error("not implemented in test");
    },
    ...overrides,
  } as ToolArtifactStorePort;
}

function digestInput(overrides: Record<string, unknown> = {}) {
  return {
    report: "x".repeat(40_000),
    description: "Explore auth flow",
    prompt: "Find how tokens refresh",
    agentType: "Explore",
    model: stubModel,
    runDigestModel: async () => "DIGEST TEXT",
    artifactStore: fakeArtifactStore(),
    sessionId: "child-session",
    toolCallId: "tool-1",
    trace: { traceId: "trace-1" },
    logger: noopLogger,
    fallbackOutputPath: "/tmp/agents/output.txt",
    ...overrides,
  };
}

test("resolveSubagentResultDigestConfig defaults to enabled with 32KB threshold", () => {
  const resolved = resolveSubagentResultDigestConfig(undefined, {});
  assert.deepEqual(resolved, { enabled: true, thresholdBytes: 32_000 });
});

test("resolveSubagentResultDigestConfig honors config disable and env escape hatch", () => {
  assert.equal(resolveSubagentResultDigestConfig({ enabled: false }, {}).enabled, false);
  assert.equal(
    resolveSubagentResultDigestConfig({ enabled: true }, { ZCODE_SUBAGENT_RESULT_DIGEST: "off" })
      .enabled,
    false,
  );
  assert.equal(
    resolveSubagentResultDigestConfig({ enabled: false }, { ZCODE_SUBAGENT_RESULT_DIGEST: "on" })
      .enabled,
    // env 只提供关闭逃生门，不提供强制开启：保持 config 关闭语义。
    false,
  );
  assert.equal(
    resolveSubagentResultDigestConfig(undefined, { ZCODE_SUBAGENT_RESULT_DIGEST: "0" }).enabled,
    false,
  );
});

test("reports at or below the threshold are passed through untouched", async () => {
  let modelCalls = 0;
  let artifactWrites = 0;
  const digest = await maybeDigestSubagentResult(
    digestInput({
      report: "a".repeat(32_000),
      runDigestModel: async () => {
        modelCalls += 1;
        return "DIGEST";
      },
      artifactStore: fakeArtifactStore({
        writeToolResultArtifact: async () => {
          artifactWrites += 1;
          throw new Error("should not write");
        },
      }),
    }),
  );
  assert.equal(digest, undefined);
  assert.equal(modelCalls, 0);
  assert.equal(artifactWrites, 0);
});

test("large reports produce a digest with artifact reference and full content preserved", async () => {
  const report = "b".repeat(40_000);
  const prompts: string[] = [];
  const writes: Array<{ content: string; toolName: string; retention?: string }> = [];
  const digest = await maybeDigestSubagentResult(
    digestInput({
      report,
      runDigestModel: async ({ prompt }) => {
        prompts.push(prompt);
        return "OUTCOME: found refresh bug";
      },
      artifactStore: fakeArtifactStore({
        writeToolResultArtifact: async (request) => {
          writes.push({
            content: request.content,
            toolName: request.toolName,
            retention: request.retention,
          });
          return {
            id: "artifact-1",
            uri: "zcode-artifact://session/artifact-1",
            path: "/tmp/zcode-artifacts/artifact-1.md",
            bytes: report.length,
            contentType: "text/markdown",
            createdAt: new Date(),
          };
        },
      }),
    }),
  );
  assert.ok(digest);
  assert.equal(digest.text, "OUTCOME: found refresh bug");
  assert.equal(digest.originalBytes, 40_000);
  assert.equal(digest.fullOutputPath, "/tmp/zcode-artifacts/artifact-1.md");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.content, report);
  assert.equal(writes[0]?.toolName, "Agent");
  assert.equal(writes[0]?.retention, "session");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]?.includes(report));
  assert.ok(prompts[0]?.includes("Explore auth flow"));
});

test("digest model failure falls back to no digest", async () => {
  const digest = await maybeDigestSubagentResult(
    digestInput({
      runDigestModel: async () => {
        throw new Error("provider 500");
      },
    }),
  );
  assert.equal(digest, undefined);
});

test("empty or summary-less digest text falls back", async () => {
  assert.equal(
    await maybeDigestSubagentResult(digestInput({ runDigestModel: async () => "   " })),
    undefined,
  );
  assert.equal(
    await maybeDigestSubagentResult(digestInput({ runDigestModel: async () => "<summary></summary>" })),
    undefined,
  );
});

test("env escape hatch disables digest even for large reports", async () => {
  let modelCalls = 0;
  const digest = await maybeDigestSubagentResult(
    digestInput({
      env: { ZCODE_SUBAGENT_RESULT_DIGEST: "off" },
      runDigestModel: async () => {
        modelCalls += 1;
        return "DIGEST";
      },
    }),
  );
  assert.equal(digest, undefined);
  assert.equal(modelCalls, 0);
});

test("artifact write failure falls back to lifecycle output path", async () => {
  const digest = await maybeDigestSubagentResult(
    digestInput({
      artifactStore: fakeArtifactStore({
        writeToolResultArtifact: async () => {
          throw new Error("disk full");
        },
      }),
    }),
  );
  assert.ok(digest);
  assert.equal(digest.fullOutputPath, "/tmp/agents/output.txt");
});

test("oversized digest text is hard capped with a truncation marker", async () => {
  const digest = await maybeDigestSubagentResult(
    digestInput({ runDigestModel: async () => "y".repeat(10_000) }),
  );
  assert.ok(digest);
  assert.ok(Buffer.byteLength(digest.text, "utf8") <= MAX_SUBAGENT_RESULT_DIGEST_BYTES);
  assert.ok(digest.text.endsWith("[digest truncated]"));
});

test("digest missing without any reference path falls back entirely", async () => {
  const digest = await maybeDigestSubagentResult(
    digestInput({ artifactStore: undefined, fallbackOutputPath: undefined }),
  );
  assert.equal(digest, undefined);
});

test("formatSubagentResultDigestReference renders digest with full report path", () => {
  const rendered = formatSubagentResultDigestReference({
    text: "OUTCOME",
    originalBytes: 40_000,
    fullOutputPath: "/tmp/full.md",
  });
  assert.ok(rendered.startsWith("OUTCOME"));
  assert.ok(rendered.includes("full_report: /tmp/full.md"));
  assert.ok(rendered.includes("(original 39 KB)"));
});

test("notification result text prefers digest and keeps full join otherwise", () => {
  const base: AgentCompletedOutput = {
    status: "completed",
    agentId: "agent-1",
    agentType: "Explore",
    description: "d",
    prompt: "p",
    content: [{ type: "text", text: "FULL REPORT" }],
    totalToolUseCount: 0,
    totalDurationMs: 1,
  };
  assert.equal(resolveSubagentNotificationResultText(base), "FULL REPORT");
  assert.equal(
    resolveSubagentNotificationResultText({
      ...base,
      digest: { text: "DIGEST", originalBytes: 40_000, fullOutputPath: "/tmp/full.md" },
    }).includes("full_report: /tmp/full.md"),
    true,
  );
});

test("AgentOutputSchema accepts digest and stays strict about unknown fields", async () => {
  const { AgentCompletedOutputSchema } = await import("@zcode/contracts");
  const parsed = AgentCompletedOutputSchema.parse({
    status: "completed",
    agentId: "agent-1",
    agentType: "Explore",
    description: "d",
    prompt: "p",
    content: [{ type: "text", text: "FULL" }],
    digest: { text: "DIGEST", originalBytes: 40_000, fullOutputPath: "/tmp/full.md" },
    totalToolUseCount: 2,
    totalDurationMs: 3,
  });
  assert.equal(parsed.digest?.text, "DIGEST");
  assert.throws(() =>
    AgentCompletedOutputSchema.parse({
      status: "completed",
      agentId: "agent-1",
      agentType: "Explore",
      description: "d",
      prompt: "p",
      content: [],
      digest: { text: "DIGEST", originalBytes: 1, fullOutputPath: "/tmp/full.md", extra: 1 },
      totalToolUseCount: 0,
      totalDurationMs: 0,
    }),
  );
});

test("formatModelContent renders digest face and keeps full face without digest", () => {
  const format = agentToolEntry.formatModelContent;
  assert.ok(format);
  const base = {
    status: "completed",
    agentId: "agent-1",
    agentType: "Explore",
    description: "d",
    prompt: "p",
    content: [{ type: "text", text: "FULLREPORTMARKER" }],
    totalToolUseCount: 1,
    totalDurationMs: 5,
    totalTokens: 7,
  };
  const fullFace = format(base);
  assert.ok(String(fullFace).includes("FULLREPORTMARKER"));

  const digestFace = String(
    format({
      ...base,
      digest: { text: "CONDENSED", originalBytes: 40_000, fullOutputPath: "/tmp/full.md" },
    }),
  );
  assert.ok(digestFace.includes("CONDENSED"));
  assert.ok(digestFace.includes("full_report: /tmp/full.md"));
  assert.ok(digestFace.includes("<usage>"));
  assert.equal(digestFace.includes("FULLREPORTMARKER"), false);
});
