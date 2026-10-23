import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT_PUSH_AUTO_INTEGRATION_CONFLICT_PREFIX } from "@zcode/shared";
import type {
  GitCommandExecutionOptions,
  GitCommandExecutionResult,
} from "../src/git/providers/gitCommandProvider.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCommandResult(
  options: GitCommandExecutionOptions,
  overrides?: Partial<GitCommandExecutionResult>,
): GitCommandExecutionResult {
  return {
    binaryPath: "git",
    cwd: options.cwd,
    args: options.args,
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

const PUSH_REJECTED_STDERR = [
  "To https://example.com/repo.git",
  " ! [rejected]        main -> main (fetch first)",
  "error: failed to push some refs",
].join("\n");

interface PushIntegrationScenario {
  /** 每次 git push 的响应；最后一次会被复用，避免越界。 */
  pushResults: Array<{ exitCode: number; stderr?: string }>;
  /** status --porcelain=v2 的 branch.ab 值，如 "+1 -2"。 */
  branchAb: string;
  /** status --porcelain 输出，默认干净工作区。 */
  porcelainStatus?: string;
  /** 集成命令（rebase / merge）的响应。 */
  integrationResult?: { exitCode: number; stderr?: string };
  /** 触发集成命令失败时模拟 git 留下的冲突状态。 */
  onIntegrationFail?: (gitDir: string) => void;
  /** 执行 abort 命令时调用，模拟回滚清理冲突状态。 */
  onAbort?: () => void;
  /** 预置的集成状态标记（模拟已有 merge/rebase 进行中）。 */
  presetMarkers?: string[];
}

function createScenarioProvider(scenario: PushIntegrationScenario) {
  const gitDir = makeTempDir("git-cli-repo-push-gitdir-");
  for (const marker of scenario.presetMarkers ?? []) {
    writeFileSync(join(gitDir, marker), "");
  }
  const calls: string[] = [];
  let pushIndex = 0;

  const run = vi.fn(
    async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
      const command = options.args.join(" ");
      calls.push(command);
      if (
        command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
      ) {
        return createCommandResult(options, { stdout: "/repo\npackages/app/\n/repo/.git\n.git\n" });
      }
      if (command.startsWith("status --porcelain=v2")) {
        return createCommandResult(options, {
          stdout: `# branch.head main\0# branch.upstream origin/main\0# branch.ab ${scenario.branchAb}\0`,
        });
      }
      if (command === "status --porcelain") {
        return createCommandResult(options, { stdout: scenario.porcelainStatus ?? "" });
      }
      if (
        command === "diff --cached --numstat -z --find-renames --" ||
        command === "diff --numstat -z --find-renames --"
      ) {
        return createCommandResult(options);
      }
      if (command === "push") {
        const attempt = scenario.pushResults[Math.min(pushIndex, scenario.pushResults.length - 1)];
        pushIndex += 1;
        return createCommandResult(options, {
          exitCode: attempt.exitCode,
          stderr: attempt.stderr ?? "",
        });
      }
      if (command === "fetch") {
        return createCommandResult(options);
      }
      if (command === "rev-parse --git-dir") {
        return createCommandResult(options, { stdout: `${gitDir}\n` });
      }
      if (command === "rebase origin/main" || command === "merge --no-edit origin/main") {
        const failure = scenario.integrationResult;
        if (failure && failure.exitCode !== 0) {
          scenario.onIntegrationFail?.(gitDir);
          return createCommandResult(options, {
            exitCode: failure.exitCode,
            stderr: failure.stderr ?? "",
          });
        }
        return createCommandResult(options);
      }
      if (command === "merge --ff-only origin/main") {
        return createCommandResult(options, {
          exitCode: scenario.integrationResult?.exitCode ?? 0,
          stderr: scenario.integrationResult?.stderr ?? "",
        });
      }
      if (command === "rebase --abort" || command === "merge --abort") {
        scenario.onAbort?.();
        return createCommandResult(options);
      }
      throw new Error(`Unexpected git command in test: ${command}`);
    },
  );

  return {
    commandProvider: {
      resolveGitBinary: vi.fn().mockResolvedValue("git"),
      run,
    },
    calls,
    gitDir,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("gitCliRepo push 自动集成远端提交", () => {
  const workspacePath = "/repo/packages/app";

  it("ahead=1 时走 rebase 集成后重推，结果披露 integration", async () => {
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: PUSH_REJECTED_STDERR }, { exitCode: 0 }],
      branchAb: "+1 -2",
    });
    const repo = createGitCliRepo({ commandProvider });

    const result = await repo.push(workspacePath);

    expect(result.integration).toEqual({
      kind: "rebase",
      remoteCommitCount: 2,
      localCommitCount: 1,
    });
    const pushCount = calls.filter((command) => command === "push").length;
    expect(pushCount).toBe(2);
    const firstPushIndex = calls.indexOf("push");
    const fetchIndex = calls.indexOf("fetch");
    const rebaseIndex = calls.indexOf("rebase origin/main");
    const retryPushIndex = calls.lastIndexOf("push");
    expect(fetchIndex).toBeGreaterThan(firstPushIndex);
    expect(rebaseIndex).toBeGreaterThan(fetchIndex);
    expect(retryPushIndex).toBeGreaterThan(rebaseIndex);
  });

  it("ahead≥2 时走 merge --no-edit 集成", async () => {
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: PUSH_REJECTED_STDERR }, { exitCode: 0 }],
      branchAb: "+3 -1",
    });
    const repo = createGitCliRepo({ commandProvider });

    const result = await repo.push(workspacePath);

    expect(result.integration).toEqual({
      kind: "merge",
      remoteCommitCount: 1,
      localCommitCount: 3,
    });
    expect(calls).toContain("merge --no-edit origin/main");
    expect(calls).not.toContain("rebase origin/main");
  });

  it("ahead=0 时走 merge --ff-only 快进", async () => {
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: PUSH_REJECTED_STDERR }, { exitCode: 0 }],
      branchAb: "+0 -2",
    });
    const repo = createGitCliRepo({ commandProvider });

    const result = await repo.push(workspacePath);

    expect(result.integration).toEqual({
      kind: "fast-forward",
      remoteCommitCount: 2,
      localCommitCount: 0,
    });
    expect(calls).toContain("merge --ff-only origin/main");
  });

  it("fetch 后 behind=0（stale info）直接重推，不进入集成", async () => {
    const staleStderr = PUSH_REJECTED_STDERR.replace("(fetch first)", "(stale info)");
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: staleStderr }, { exitCode: 0 }],
      branchAb: "+1 -0",
    });
    const repo = createGitCliRepo({ commandProvider });

    const result = await repo.push(workspacePath);

    expect(result.integration).toBeUndefined();
    expect(calls).not.toContain("rebase origin/main");
    expect(calls).not.toContain("merge --ff-only origin/main");
    expect(calls.filter((command) => command === "push").length).toBe(2);
  });

  it("rebase 冲突时 abort 回滚并抛带稳定前缀的错误，不再重推", async () => {
    const markerPath = { current: "" };
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: PUSH_REJECTED_STDERR }],
      branchAb: "+1 -2",
      integrationResult: { exitCode: 1, stderr: "CONFLICT (content): Merge conflict in a.ts" },
      onIntegrationFail: (dir) => {
        markerPath.current = join(dir, "rebase-merge");
        mkdirSync(markerPath.current, { recursive: true });
      },
      onAbort: () => {
        rmSync(markerPath.current, { recursive: true, force: true });
      },
    });
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.push(workspacePath)).rejects.toThrow(
      new RegExp(`^${GIT_PUSH_AUTO_INTEGRATION_CONFLICT_PREFIX}`),
    );
    expect(calls).toContain("rebase --abort");
    expect(calls.filter((command) => command === "push").length).toBe(1);
    // 回滚后冲突状态标记应已被 abort 清理。
    expect(calls[calls.length - 1]).toBe("rebase --abort");
  });

  it("工作区有未提交改动时拒绝自动集成", async () => {
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: PUSH_REJECTED_STDERR }],
      branchAb: "+1 -2",
      porcelainStatus: " M a.ts\n",
    });
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.push(workspacePath)).rejects.toThrow(/uncommitted changes/);
    expect(calls).not.toContain("rebase origin/main");
    expect(calls).toContain("status --porcelain");
  });

  it("已有进行中的 merge 时拒绝自动集成", async () => {
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: PUSH_REJECTED_STDERR }],
      branchAb: "+1 -2",
      presetMarkers: ["MERGE_HEAD"],
    });
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.push(workspacePath)).rejects.toThrow(/already in progress/);
    expect(calls).not.toContain("merge --no-edit origin/main");
  });

  it("非快进以外的失败（鉴权等）原样抛出，不 fetch", async () => {
    const { commandProvider, calls } = createScenarioProvider({
      pushResults: [{ exitCode: 128, stderr: "fatal: Authentication failed" }],
      branchAb: "+1 -2",
    });
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.push(workspacePath)).rejects.toThrow(/git push failed/);
    expect(calls).not.toContain("fetch");
  });

  it("集成成功但重推仍被拒时，原样抛出第二次失败", async () => {
    const { commandProvider } = createScenarioProvider({
      pushResults: [
        { exitCode: 128, stderr: PUSH_REJECTED_STDERR },
        { exitCode: 128, stderr: PUSH_REJECTED_STDERR },
      ],
      branchAb: "+1 -2",
    });
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.push(workspacePath)).rejects.toThrow(/git push failed/);
  });
});
