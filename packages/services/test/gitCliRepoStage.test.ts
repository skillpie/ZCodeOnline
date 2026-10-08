import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

// 提交弹窗勾选"包含未暂存更改"时，已暂存删除（porcelain x=D）的路径会随其它
// 变更一起传给 `git add`；该路径在索引和工作区都不存在，pathspec 匹配不到任何
// 文件会导致整批提交失败。验收：stage() 幂等跳过这类路径，其余路径正常暂存，
// 语义不明的冲突路径与不存在的路径保持原有行为。

const execFileAsync = promisify(execFile);
const repo = createGitCliRepo();

let root = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

async function statusShort(): Promise<string[]> {
  return (await git("status", "--porcelain")).split("\n").filter((line) => line.length > 0);
}

before(async () => {
  // macOS 的 tmpdir 位于 /var 符号链接下，git rev-parse 返回真实路径，
  // 这里先归一，避免 normalizeInputPath 把不存在路径误判为仓库外。
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-stage-")));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, "b.txt"), "b\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("stage 对已暂存删除的路径幂等跳过，并正常暂存其余路径", async () => {
  // a.txt → `D `（已暂存删除），b.txt → ` M`（未暂存修改）。
  await git("rm", "-q", "a.txt");
  await writeFile(join(root, "b.txt"), "b2\n");
  assert.deepEqual(await statusShort(), ["D  a.txt", " M b.txt"]);

  await repo.stage(root, ["a.txt", "b.txt"]);

  assert.deepEqual(await statusShort(), ["D  a.txt", "M  b.txt"]);
});

test("stage 仅传已暂存删除的路径时不抛错且状态不变", async () => {
  assert.deepEqual(await statusShort(), ["D  a.txt", "M  b.txt"]);
  await repo.stage(root, ["a.txt"]);
  assert.deepEqual(await statusShort(), ["D  a.txt", "M  b.txt"]);
});

test("stage 对索引和工作区都不存在且非已暂存删除的路径仍报错", async () => {
  await assert.rejects(repo.stage(root, ["missing.txt"]), /git add failed/);
});
