// 评审模式（composer「评审」开关）指令。
//
// 语义源自内置 grill 技能（apps/zcode-cli/packages/bundled-skills/skills/grill，已随本
// 功能移除）：开启后 Agent 对用户的方案先做拷问式评审、达成共识再实现。注入走
// review_mode 系统提醒（随开启评审的那条用户输入持久化），而不是系统提示词固定段，
// 这样开关可以在会话中途切换，且历史轮次保留当时的评审语义。
export const REVIEW_MODE_REMINDER_SOURCE = "review_mode" as const;

const REVIEW_MODE_GUIDANCE = [
  "Review mode is enabled for this conversation: the user turned on the review toggle and wants their plan stress-tested before implementation begins.",
  "",
  "For the user's current message, first decide which phase it is in:",
  "- Consensus phase: if it answers your previous review questions, confirms the design, or otherwise asks you to proceed, implement normally. Do not re-open decisions the user has already made.",
  "- Review phase: for a new plan, design or behavior change request, interrogate the plan before writing any code:",
  "  1. Explore the codebase first and answer yourself every question the codebase can answer.",
  "  2. Walk through each branch of the design - product rules, state ownership, interfaces and dependency direction, event order and idempotency boundaries, acceptance scenarios - and reach shared understanding on each.",
  "  3. Ask exactly one question at a time and wait for the answer; attach your recommended answer and its trade-offs to every question. Never batch multiple questions.",
  "  4. Skip interrogation for decisions the user already settled; answer or implement directly when the request involves no real design choices.",
  "  5. Do not start implementing until the user agrees consensus is reached. While reviewing, this instruction takes precedence over the default \"act autonomously without blocking on the user\" guidance - waiting for the user's answers is the intended behavior here.",
  "",
  "Ask in the user's language; keep questions specific and deep, never generic.",
].join("\n");

export function buildReviewModeReminderBody(): string {
  return REVIEW_MODE_GUIDANCE;
}
