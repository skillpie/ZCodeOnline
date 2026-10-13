import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

// 分支行新增的「删除分支」能力。默认安全删（git branch -d）：仅删已合并分支；
// 未合并时 git 拒绝并翻译为 branch-not-fully-merged，UI 二次确认后携带 force 重试（-D）。
// 挂在任意 worktree 的分支与当前检出的分支被前置拒绝。

const execFileAsync = promisify(execFile);
const repo = createGitCliRepo();

let root = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

function issueCodes(result: { issues: Array<{ code: string }> }): string[] {
  return result.issues.map((issue) => issue.code);
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-branch-delete-")));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "init"], { cwd: root });
  // 合并副本：与 main 同 commit，-d 可删。
  await git("branch", "merged-copy");
  // 未合并副本：领先 main 一个提交，-d 拒绝。
  await git("checkout", "-q", "-b", "feature/unmerged");
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "experiment"], { cwd: root });
  await git("checkout", "-q", "main");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("deleteBranch 安全删除已合并副本分支", async () => {
  const result = await repo.deleteBranch(root, "merged-copy");

  assert.equal(result.ok, true);
  assert.equal(result.action, "delete");
  assert.equal(result.branchName, "merged-copy");
  const branches = await git("branch", "--list", "merged-copy");
  assert.equal(branches.trim(), "");
});

test("deleteBranch 对未合并分支先拒绝，force 重试后删除", async () => {
  const blocked = await repo.deleteBranch(root, "feature/unmerged");
  assert.equal(blocked.ok, false);
  assert.deepEqual(issueCodes(blocked), ["branch-not-fully-merged"]);

  const branches = await git("branch", "--list", "feature/unmerged");
  assert.ok(branches.includes("feature/unmerged"));

  const forced = await repo.deleteBranch(root, "feature/unmerged", { force: true });
  assert.equal(forced.ok, true);
  const afterForce = await git("branch", "--list", "feature/unmerged");
  assert.equal(afterForce.trim(), "");
});

test("deleteBranch 拒绝当前分支、worktree 占用分支与不存在的分支", async () => {
  const current = await repo.deleteBranch(root, "main");
  assert.equal(current.ok, false);
  assert.deepEqual(issueCodes(current), ["branch-is-current"]);

  // worktree 占用的分支：建一个 worktree 后再删其分支。
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-branch-del-ext-")));
  try {
    await git("branch", "feature/occupied");
    await git("worktree", "add", "-q", externalDir, "feature/occupied");
    const occupied = await repo.deleteBranch(root, "feature/occupied");
    assert.equal(occupied.ok, false);
    assert.deepEqual(issueCodes(occupied), ["branch-in-other-worktree"]);
    await git("worktree", "remove", "--force", externalDir);
  } finally {
    await rm(externalDir, { recursive: true, force: true });
  }

  const missing = await repo.deleteBranch(root, "no-such-branch");
  assert.equal(missing.ok, false);
  assert.deepEqual(issueCodes(missing), ["target-branch-not-found"]);
});

test("switchBranch 对主工作区占用的目标分支返回 branch-in-main-worktree", async () => {
  // 主树当前在 main；从 worktree 侧尝试切到 main，持有方是主工作区 → 专用 issue。
  // 建一个持有临时分支的 worktree，再尝试切到被主工作区占用的 main。
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-switch-main-")));
  try {
    await git("worktree", "add", "-q", "-b", "wt-switch-tmp", externalDir);
    const blocked = await repo.switchBranch(externalDir, "main");
    assert.equal(blocked.ok, false);
    assert.deepEqual(issueCodes(blocked), ["branch-in-main-worktree"]);
  } finally {
    await git("worktree", "remove", "--force", externalDir);
    await rm(externalDir, { recursive: true, force: true });
    await git("branch", "-D", "wt-switch-tmp");
  }
});
