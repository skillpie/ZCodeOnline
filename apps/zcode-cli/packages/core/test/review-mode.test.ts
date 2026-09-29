// 评审模式（composer 评审开关）注入的单元覆盖。
// 核心不变量：reviewMode 开启 ⇒ 用户输入后追加 review_mode 系统提醒（裸文本，
// 投影层负责包 <system-reminder> 标签）；关闭 ⇒ 行为与原来完全一致。
import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeUserEntriesFromTurn } from "../src/runtime/helpers/conversation.js";
import {
  buildReviewModeReminderBody,
  REVIEW_MODE_REMINDER_SOURCE,
} from "../src/system-reminder/review-mode.js";
import { wrapSystemReminderForSource } from "../src/system-reminder/source.js";
import type { ResolvedTurnAttachment } from "../src/runtime/types.js";

function textAttachment(text: string): ResolvedTurnAttachment {
  return {
    contentBlock: { type: "text", text },
    mime: "text/plain",
    metadata: {
      storageKind: "inline",
      recoverability: "provider_ready",
      preview: { text },
    },
    url: "",
  };
}

test("review mode off keeps user entries unchanged", () => {
  const entries = buildRuntimeUserEntriesFromTurn("实现登录页", []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, undefined);
  assert.ok("message" in entries[0]!);
});

test("review mode on appends review_mode reminder after user input", () => {
  const entries = buildRuntimeUserEntriesFromTurn("实现登录页", [], { reviewMode: true });
  assert.equal(entries.length, 2);
  const reminder = entries[1]!;
  assert.equal(reminder.kind, "attachment");
  assert.equal(
    reminder.kind === "attachment" ? reminder.metadata.source : undefined,
    REVIEW_MODE_REMINDER_SOURCE,
  );
  const body = reminder.kind === "attachment" ? reminder.content : "";
  // 裸文本：不含 system-reminder 标签（由 provider 投影统一包裹），但语义完整。
  assert.ok(!body.includes("<system-reminder>"));
  assert.ok(body.includes("Review mode is enabled"));
  assert.ok(body.includes("one question at a time"));
});

test("review reminder is ordered after prompt attachments", () => {
  const entries = buildRuntimeUserEntriesFromTurn("审查这份方案", [textAttachment("方案正文")], {
    reviewMode: true,
  });
  const sources = entries.map((entry) =>
    entry.kind === "attachment" ? entry.metadata.source : "message",
  );
  // 评审指令排在附件之后：它约束整个 turn 的行为阶段，不是用户资料。
  assert.deepEqual(sources, ["message", "prompt_attachment", REVIEW_MODE_REMINDER_SOURCE]);
});

test("review_mode source is registered and provider-visible", () => {
  const wrapped = wrapSystemReminderForSource(REVIEW_MODE_REMINDER_SOURCE, [
    buildReviewModeReminderBody(),
  ]);
  assert.ok(wrapped.startsWith("<system-reminder>"));
  assert.ok(wrapped.endsWith("</system-reminder>"));
});
