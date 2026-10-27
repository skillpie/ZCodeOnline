#!/usr/bin/env node
// fork 禁区检查：fork（skillpie/ZCodeOnline）持续集成官方版本（zai-org/ZCode）时，
// 本仓库对上游高频改动文件（冲突热区）的存量改动必须保持可控。本脚本对
// `git diff <base>...HEAD` 的改动文件清单做禁区断言，出现**新增**违规即退出码 1。
//
// 用法：
//   node scripts/check-fork-diff.mjs [base-ref] [--list] [--update-baseline]
// base-ref 缺省时依次探测 zai/main、upstream/main、origin/main。
// 退出码：0 = 通过；1 = 出现基线外的新增禁区改动；2 = 无法确定 base（需显式传参）。
//
// 基线棘轮：存量禁区改动记录在 scripts/fork-diff-baseline.json（2026-10 盘点，
// 属于待随 extension API 外移的历史定制）。基线只减不增：`--update-baseline`
// 仅供评审后的有意接受使用，CI 与日常检查都不会自动刷新基线——与
// `pnpm architecture:baseline:update` 同一套纪律。
//
// 禁区清单的依据是 2026-10 对近 4 个月上游提交的文件级频次统计（>=5 次的
// agent 运行时核心文件）。新增禁区时同步更新本脚本的 FORBIDDEN_PATHS。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const FORBIDDEN_PATHS = [
  // agent 运行时类型与装配：上游改动最频繁的文件（近 4 个月 8 次）
  "apps/zcode-cli/packages/core/src/runtime/types.ts",
  // turn 循环与工具执行器
  "apps/zcode-cli/packages/core/src/runtime/methods/turn.ts",
  "apps/zcode-cli/packages/core/src/tool/types.ts",
  "apps/zcode-cli/packages/core/src/tool/executor/",
  // 会话事件契约：上游持续演进
  "apps/zcode-cli/packages/contracts/src/events/session.events.ts",
  // 协议命令处理器
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/",
];

const BASE_REF_CANDIDATES = ["zai/main", "upstream/main", "origin/main"];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fork-diff-baseline.json");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function resolveBaseRef() {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (positional) {
    git(["rev-parse", "--verify", positional]);
    return positional;
  }
  for (const candidate of BASE_REF_CANDIDATES) {
    try {
      git(["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      // 探测下一个候选
    }
  }
  console.error(
    `无法确定 base ref（尝试过 ${BASE_REF_CANDIDATES.join("、")}）。请显式传参，例如：\n` +
      `  node scripts/check-fork-diff.mjs zai/main`,
  );
  process.exit(2);
}

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.accepted)) {
      return parsed.accepted.filter((entry) => typeof entry === "string");
    }
  } catch {
    // 基线文件缺席 = 空基线，全部违规都按新增处理
  }
  return [];
}

const base = resolveBaseRef();
const mergeBase = git(["merge-base", base, "HEAD"]);
const changedFiles = git(["diff", "--name-only", `${mergeBase}...HEAD`])
  .split("\n")
  .filter(Boolean);

if (process.argv.includes("--list")) {
  for (const file of changedFiles) console.log(file);
}

const violations = changedFiles.filter((file) =>
  FORBIDDEN_PATHS.some((forbidden) => file === forbidden || file.startsWith(forbidden)),
);

if (process.argv.includes("--update-baseline")) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        comment:
          "存量禁区改动清单（2026-10 盘点）：fork 已有定制，计划随 extension-host 外移后逐项移除。新增禁区改动必须先评审再更新本文件；CI 不自动刷新基线。",
        accepted: [...new Set(violations)].sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`基线已更新：${new Set(violations).size} 条（base=${base}）。`);
  process.exit(0);
}

const accepted = new Set(readBaseline());
const newViolations = violations.filter((file) => !accepted.has(file));

if (newViolations.length > 0) {
  console.error(
    `fork diff 相对 ${base} 出现 ${newViolations.length} 个基线外的禁区改动：\n` +
      newViolations.map((file) => `  - ${file}`).join("\n") +
      `\n禁区是上游高频改动的冲突热区；fork 逻辑应放进新目录或通过现有注入点装配。` +
      `\n确需例外时先评审再更新 scripts/fork-diff-baseline.json（只减不增）。`,
  );
  process.exit(1);
}

const staleBaseline = readBaseline().filter((entry) => !violations.includes(entry));
console.log(
  `fork diff 检查通过：${changedFiles.length} 个改动文件，禁区改动 ${violations.length} 个（全部在基线内` +
    `${staleBaseline.length > 0 ? `，其中 ${staleBaseline.length} 条基线已可清理` : ""}，base=${base}）。`,
);
