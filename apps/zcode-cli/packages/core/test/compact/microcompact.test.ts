import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE,
  MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX,
  maybeLocalMicrocompactMessages,
  type LocalMicrocompactMessage,
} from "../../src/compact/microcompact.js";

const ARTIFACT_LOG_A = "/tmp/zcode-artifacts/bash-a1.log";
const ARTIFACT_LOG_B = "/tmp/zcode-artifacts/bash-b2.log";

function persistedOutputEnvelope(path: string): string {
  return [
    "<persisted-output>",
    `Output too large (48.2 KB). Full output saved to: ${path}`,
    "",
    "Preview (first 2.0 KB):",
    "x".repeat(1_200),
    "</persisted-output>",
  ].join("\n");
}

function resultBudgetTruncated(path: string): string {
  return `${"y".repeat(600)}\n\n[Tool output truncated by resultBudget: artifactPath=${path}, originalBytes=48211, maxModelBytes=30000, strategy=head]`;
}

function plainResult(body: string): string {
  return `${body}${"z".repeat(600)}`;
}

function buildRounds(results: string[]): LocalMicrocompactMessage[] {
  return results.flatMap((content, index) => [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: `call_${index}`, input: { command: `cmd ${index}` }, name: "Bash" }],
    },
    {
      role: "tool",
      toolCallId: `call_${index}`,
      toolName: "Bash",
      content,
    },
  ]);
}

function toolMessageById(
  messages: readonly LocalMicrocompactMessage[],
  id: string,
): LocalMicrocompactMessage {
  const message = messages.find(
    (candidate) => candidate.role === "tool" && candidate.toolCallId === id,
  );
  assert.ok(message, `expected tool message ${id}`);
  return message;
}

const TRIGGER_CONFIG = { thresholdTokens: 1 } as const;

describe("microcompact artifact pointer preservation", () => {
  it("清理 persisted-output 信封结果时在占位符中保留 artifact 路径", () => {
    const input = buildRounds([
      persistedOutputEnvelope(ARTIFACT_LOG_A),
      resultBudgetTruncated(ARTIFACT_LOG_B),
      plainResult("round-3"),
      plainResult("round-4"),
      plainResult("round-5"),
      plainResult("round-6"),
      plainResult("round-7"),
    ]);

    const result = maybeLocalMicrocompactMessages({ config: TRIGGER_CONFIG, messages: input });

    assert.equal(result.decision.reason, "applied");
    assert.deepEqual(result.payload?.clearedToolCallIds, ["call_0", "call_1"]);

    const clearedA = toolMessageById(result.messages, "call_0");
    assert.equal(
      clearedA.content,
      `${MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX}\nFull output saved to: ${ARTIFACT_LOG_A}`,
    );

    const clearedB = toolMessageById(result.messages, "call_1");
    assert.equal(
      clearedB.content,
      `${MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX}\nFull output saved to: ${ARTIFACT_LOG_B}`,
    );

    for (const index of [2, 3, 4, 5, 6]) {
      const kept = toolMessageById(result.messages, `call_${index}`);
      assert.equal(kept.content, input[index * 2 + 1]!.content);
    }
  });

  it("普通结果清理后保持原占位符，且不误报自由文本中的路径句式", () => {
    const input = buildRounds([
      plainResult("round-1"),
      plainResult(`mentions Full output saved to: /tmp/fake.log inline`),
      plainResult("round-3"),
      plainResult("round-4"),
      plainResult("round-5"),
      plainResult("round-6"),
      plainResult("round-7"),
    ]);

    const result = maybeLocalMicrocompactMessages({ config: TRIGGER_CONFIG, messages: input });

    assert.equal(result.decision.reason, "applied");
    assert.deepEqual(result.payload?.clearedToolCallIds, ["call_0", "call_1"]);

    for (const id of ["call_0", "call_1"]) {
      assert.equal(toolMessageById(result.messages, id).content, MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE);
    }
  });

  it("已清理内容（含带指针变体）不进入二次清理候选", () => {
    const input = buildRounds([
      persistedOutputEnvelope(ARTIFACT_LOG_A),
      plainResult("round-2"),
      plainResult("round-3"),
      plainResult("round-4"),
      plainResult("round-5"),
      plainResult("round-6"),
      plainResult("round-7"),
    ]);

    const firstPass = maybeLocalMicrocompactMessages({ config: TRIGGER_CONFIG, messages: input });
    assert.equal(firstPass.decision.reason, "applied");

    const secondPass = maybeLocalMicrocompactMessages({
      config: TRIGGER_CONFIG,
      messages: firstPass.messages,
    });
    assert.equal(secondPass.decision.reason, "nothing_to_clear");
    assert.equal(secondPass.payload, undefined);
  });
});
