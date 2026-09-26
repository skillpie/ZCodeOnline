// ============================================================
// Subagent Result Digest - 大结果压缩回传
// ============================================================
// 规则与失败语义见 specs/subagent-result-digest.md。摘要只改变消费方
// （agent handler 模型可见面、后台 task-notification）读取的字段；
// AgentCompletedOutput.content 恒为全文，摘要失败时输出对象不含 digest 字段。

import type {
  AgentCompletedOutput,
  AgentResultDigest,
  Logger,
  Model,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
} from "@zcode/contracts";

export const DEFAULT_SUBAGENT_RESULT_DIGEST_THRESHOLD_BYTES = 32_000;
export const MAX_SUBAGENT_RESULT_DIGEST_BYTES = 6_000;

const DIGEST_MODEL_MAX_OUTPUT_TOKENS = 2_048;
const DIGEST_MODEL_TIMEOUT_MS = 60_000;
const DIGEST_TARGET_CHARS = 4_000;
const DIGEST_TRUNCATION_SUFFIX = "\n[digest truncated]";

export interface SubagentResultDigestConfig {
  enabled?: boolean;
  thresholdBytes?: number;
}

export interface ResolvedSubagentResultDigestConfig {
  enabled: boolean;
  thresholdBytes: number;
}

export interface SubagentResultDigest {
  text: string;
  originalBytes: number;
  fullOutputPath: string;
}

export type SubagentResultDigestModelRunner = (input: {
  model: Model;
  prompt: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  traceContext: TraceContext;
}) => Promise<string>;

export interface MaybeDigestSubagentResultInput {
  report: string;
  description: string;
  prompt: string;
  agentType: string;
  config?: SubagentResultDigestConfig;
  /** 本次 Agent 调用继承的执行模型（SubagentRunOptions.model）；缺席即不摘要。 */
  model?: Model;
  runDigestModel?: SubagentResultDigestModelRunner;
  artifactStore?: ToolArtifactStorePort;
  sessionId: SessionId;
  toolCallId: string;
  trace: TraceContext;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /** artifact 不可用时的全文回退引用（lifecycle.outputFile）。 */
  fallbackOutputPath?: string;
  /** 供测试注入；生产路径读 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * env 逃生门优先于 config：AgentRuntimeConfig 的组装方较多（桌面/Web/TUI/bootstrap），
 * 任何一条路径漏传 config 时仍能通过 ZCODE_SUBAGENT_RESULT_DIGEST=off 一键关闭。
 * 参数化 env 便于测试（参照 task-output.ts 的 TASK_MAX_OUTPUT_LENGTH 先例）。
 */
export function resolveSubagentResultDigestConfig(
  config: SubagentResultDigestConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSubagentResultDigestConfig {
  const envValue = env.ZCODE_SUBAGENT_RESULT_DIGEST?.trim().toLowerCase();
  const envDisabled = envValue === "off" || envValue === "false" || envValue === "0";
  return {
    enabled: !envDisabled && config?.enabled !== false,
    thresholdBytes: config?.thresholdBytes ?? DEFAULT_SUBAGENT_RESULT_DIGEST_THRESHOLD_BYTES,
  };
}

export async function maybeDigestSubagentResult(
  input: MaybeDigestSubagentResultInput,
): Promise<SubagentResultDigest | undefined> {
  const config = resolveSubagentResultDigestConfig(input.config, input.env);
  const originalBytes = Buffer.byteLength(input.report, "utf8");
  if (!config.enabled || originalBytes <= config.thresholdBytes) return undefined;
  if (!input.model || !input.runDigestModel) return undefined;

  const fullOutputPath =
    (await writeDigestArtifact(input)) ?? input.fallbackOutputPath ?? undefined;

  try {
    // 超时用独立 signal 合并进调用方 abort；摘要不是关键路径，不能比正文回传还长寿。
    const timeoutSignal = AbortSignal.timeout(DIGEST_MODEL_TIMEOUT_MS);
    const signal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, timeoutSignal])
      : timeoutSignal;
    const raw = await input.runDigestModel({
      model: input.model,
      prompt: buildDigestPrompt(input.description, input.prompt, input.report),
      maxOutputTokens: DIGEST_MODEL_MAX_OUTPUT_TOKENS,
      abortSignal: signal,
      traceContext: input.trace,
    });
    const text = capDigestText(extractDigestText(raw));
    // spec 不变量：digest 存在 ⇒ 必有 fullOutputPath；拿不到引用路径时整体回退全文。
    if (!text || !fullOutputPath) {
      input.logger?.warn("Subagent result digest produced no usable text; keeping full report", {
        agentType: input.agentType,
        event: "subagent.digest.empty",
        module: "core.subagent",
        originalBytes,
      });
      return undefined;
    }
    return { text, originalBytes, fullOutputPath };
  } catch (error) {
    if (input.abortSignal?.aborted) {
      input.logger?.debug("Subagent result digest skipped after abort", {
        agentType: input.agentType,
        module: "core.subagent",
      });
      return undefined;
    }
    input.logger?.warn("Subagent result digest failed; falling back to full report", {
      agentType: input.agentType,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.digest.failed",
      module: "core.subagent",
      originalBytes,
    });
    return undefined;
  }
}

/** 模型可见面 / 后台通知共用的 digest + 全文引用渲染。 */
export function formatSubagentResultDigestReference(digest: AgentResultDigest): string {
  const kb = Math.max(1, Math.round(digest.originalBytes / 1024));
  return `${digest.text}\n\nfull_report: ${digest.fullOutputPath} (original ${kb} KB)`;
}

/** 后台通知 `<result>` 面的字段取舍：有 digest 用摘要，否则全文 join（现状）。 */
export function resolveSubagentNotificationResultText(output: AgentCompletedOutput): string {
  return output.digest
    ? formatSubagentResultDigestReference(output.digest)
    : output.content.map((block) => block.text).join("\n\n");
}

async function writeDigestArtifact(
  input: MaybeDigestSubagentResultInput,
): Promise<string | undefined> {
  if (!input.artifactStore) return undefined;
  try {
    const artifact = await input.artifactStore.writeToolResultArtifact(
      {
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: "Agent",
        content: input.report,
        contentType: "text/markdown",
        retention: "session",
        trace: input.trace,
      },
      { signal: input.abortSignal },
    );
    return artifact.path ?? artifact.uri;
  } catch (error) {
    // artifact 只影响可追溯性，写失败不阻断摘要；fullOutputPath 会回退 lifecycle 输出文件。
    input.logger?.debug("Subagent result digest artifact write failed", {
      agentType: input.agentType,
      errorMessage: error instanceof Error ? error.message : String(error),
      module: "core.subagent",
    });
    return undefined;
  }
}

function buildDigestPrompt(description: string, prompt: string, report: string): string {
  return [
    "Compress the finished subagent's final report below for the coordinating agent's context.",
    "Rules:",
    "- Write in the same language as the report.",
    "- Start with a short outcome paragraph, then key findings/changes as bullets.",
    // 精确标识符是主 agent 后续行动的原料，摘要丢失它们等于没摘要。
    "- Preserve exact file paths, commands, identifiers, and numbers verbatim.",
    "- Never invent information; if the report is ambiguous, state that.",
    `- Target at most ${DIGEST_TARGET_CHARS} characters. Output only the digest text, no preamble.`,
    "",
    `Task description: ${description}`,
    `Task prompt:`,
    prompt,
    `Final report:`,
    report,
  ].join("\n");
}

function extractDigestText(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) text = (summaryMatch[1] ?? "").trim();
  return text;
}

function capDigestText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_SUBAGENT_RESULT_DIGEST_BYTES) return text;
  const limit = MAX_SUBAGENT_RESULT_DIGEST_BYTES - Buffer.byteLength(DIGEST_TRUNCATION_SUFFIX);
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > limit) {
    end -= 1;
  }
  return `${text.slice(0, end)}${DIGEST_TRUNCATION_SUFFIX}`;
}
