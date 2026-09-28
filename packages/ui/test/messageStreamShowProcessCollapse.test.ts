import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "../src/v4/conversationTurnRenderUnits.js";

const TURN_ID = "turn-1";

let nextRowId = 1;

function rowBase(createdAtSeq: number) {
  const rowId = nextRowId++;
  return { rowId, turnId: TURN_ID, createdAt: 1_000 + createdAtSeq, createdAtSeq };
}

function turnHeader(state: "running" | "completedSuccess" | "completedInterrupted" | "failed") {
  return {
    ...rowBase(0),
    kind: "turnHeader" as const,
    origin: "userInput" as const,
    executionKind: "agent" as const,
    state,
    startedAt: 1_000,
    ...(state === "running" ? {} : { endedAt: 2_000, activeMs: 1_000 }),
  };
}

function userInputRow() {
  return {
    ...rowBase(1),
    kind: "userInput" as const,
    text: "帮我修一下",
    origin: "realUser" as const,
  };
}

function reasoningRow(seq: number) {
  return {
    ...rowBase(seq),
    kind: "reasoning" as const,
    text: "先找根因",
    state: "complete" as const,
  };
}

function toolCallRow(seq: number, toolName = "Bash") {
  return {
    ...rowBase(seq),
    kind: "toolCall" as const,
    toolCallId: `call-${seq}`,
    toolName,
    status: "success" as const,
    inputText: "{}",
  };
}

function assistantTextRow(seq: number) {
  return {
    ...rowBase(seq),
    kind: "assistantText" as const,
    text: "修好了",
    state: "complete" as const,
    actions: { canFork: true as const, canRetry: true as const },
  };
}

function buildRunningTurnRows(): ConversationRow[] {
  return [
    turnHeader("running"),
    userInputRow(),
    reasoningRow(2),
    toolCallRow(3),
    toolCallRow(4, "Read"),
  ];
}

function buildCompletedTurnRows(): ConversationRow[] {
  return [
    turnHeader("completedSuccess"),
    userInputRow(),
    reasoningRow(2),
    toolCallRow(3),
    assistantTextRow(4),
  ];
}

test("设置关闭时运行中轮的执行过程默认折叠，开启或缺省保持展开", () => {
  for (const showProcess of [undefined, true]) {
    const [unit] = buildConversationTurnRenderUnits(buildRunningTurnRows(), {
      ...(showProcess === undefined ? {} : { messageStreamShowProcess: showProcess }),
    });
    const segment = unit?.workSegments?.at(-1);
    assert.equal(unit?.assistantHistoryDefaultOpen, true);
    assert.equal(segment?.assistantHistoryDefaultOpen, true);
  }

  const [collapsed] = buildConversationTurnRenderUnits(buildRunningTurnRows(), {
    messageStreamShowProcess: false,
  });
  assert.equal(collapsed?.assistantHistoryDefaultOpen, false);
  assert.equal(collapsed?.workSegments?.at(-1)?.assistantHistoryDefaultOpen, false);
});

test("设置关闭时完成轮执行过程保持折叠且最终正文不受影响", () => {
  const [unit] = buildConversationTurnRenderUnits(buildCompletedTurnRows(), {
    messageStreamShowProcess: false,
  });
  assert.equal(unit?.workSegments?.at(-1)?.assistantHistoryDefaultOpen, false);
  // 只返回最终结果：正文行不在折叠区内，折叠不影响最终答复渲染。
  assert.equal(unit?.latestAssistantTextRow?.kind, "assistantText");
  assert.ok(unit?.workSegments?.at(-1)?.flowItems.some((item) => item.kind === "assistantText"));
});

test("设置关闭时失败与中断轮仍强制展开过程（异常上下文必须可见）", () => {
  for (const state of ["failed", "completedInterrupted"] as const) {
    const rows = buildCompletedTurnRows().map((row) =>
      row.kind === "turnHeader" ? { ...row, state } : row,
    );
    const [unit] = buildConversationTurnRenderUnits(rows, { messageStreamShowProcess: false });
    assert.equal(unit?.workSegments?.at(-1)?.assistantHistoryDefaultOpen, true, state);
  }
});

test("无“已工作”触发器（controlOnly 无 workStatus）的分段不折叠，避免折叠后无法展开", () => {
  const rows: ConversationRow[] = [
    { ...turnHeader("completedSuccess"), executionKind: "controlOnly" as const },
    toolCallRow(1),
  ];
  const [unit] = buildConversationTurnRenderUnits(rows, { messageStreamShowProcess: false });
  // workStatus 缺失 → 没有任何再展开入口，保持展开兜底。
  assert.equal(unit?.workStatus, undefined);
  assert.equal(unit?.workSegments?.at(-1)?.assistantHistoryDefaultOpen, true);
});

test("appSettings 默认开启显示执行过程且 patch 接受该字段", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.messageStreamShowProcess, true);
  const patched = appSettingsSchema.parse({ messageStreamShowProcess: false });
  assert.equal(patched.messageStreamShowProcess, false);
});
