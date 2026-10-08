import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

// Review 面板「撤销改动」按未暂存行逐文件丢弃。工作区三类状态此前只有普通改动可走
// `git restore --worktree`：未跟踪路径（porcelain `?`）不在索引里会报 pathspec 不识别，
// 冲突路径（porcelain `u`）会报 unmerged。验收：discard() 未暂存分支对三类状态都能
// 撤销——未跟踪删除、冲突以 HEAD 覆盖、普通改动仅回退工作区并保留已暂存内容；
// 不存在的路径保持原有报错行为。

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

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(access(path), /ENOENT/);
}

async function commitFile(path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content);
  await git("add", path);
  await git("commit", "-qm", `init ${path}`);
}

before(async () => {
  // macOS 的 tmpdir 位于 /var 符号链接下，git rev-parse 返回真实路径，
  // 这里先归一，避免 normalizeInputPath 把不存在路径误判为仓库外。
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-discard-")));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await commitFile("staged.txt", "staged\n");
  await commitFile("conflict.txt", "base\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("discard 未暂存时对普通改动仅回退工作区，保留已暂存内容", async () => {
  // staged.txt → `MM`：第一行已暂存，第二行未暂存。
  await writeFile(join(root, "staged.txt"), "staged\nworktree\n");
  await git("add", "staged.txt");
  await writeFile(join(root, "staged.txt"), "staged\nworktree+dirty\n");
  assert.deepEqual(await statusShort(), ["MM staged.txt"]);

  await repo.discard(root, ["staged.txt"], false);

  assert.deepEqual(await statusShort(), ["M  staged.txt"]);
});

test("discard 未暂存时删除未跟踪文件与折叠的未跟踪目录", async () => {
  await writeFile(join(root, "untracked.txt"), "new\n");
  await mkdir(join(root, "build"));
  await writeFile(join(root, "build/out.js"), "artifact\n");
  // 目录整体未跟踪时 porcelain v2 折叠为 `?? build/`，撤销入口同样传目录路径。
  assert.deepEqual(await statusShort(), ["M  staged.txt", "?? build/", "?? untracked.txt"]);

  await repo.discard(root, ["untracked.txt", "build/"], false);

  assert.deepEqual(await statusShort(), ["M  staged.txt"]);
  await assertPathMissing(join(root, "untracked.txt"));
  await assertPathMissing(join(root, "build"));
});

test("discard 未暂存时以 HEAD 覆盖冲突路径并解除 unmerged 状态", async () => {
  // 制造 UU 冲突：分支上改 conflict.txt 并提交，回到 main 再改同一文件后合并。
  await git("checkout", "-q", "-b", "feature");
  await writeFile(join(root, "conflict.txt"), "feature\n");
  await git("commit", "-qam", "feature change");
  await git("checkout", "-q", "main");
  await writeFile(join(root, "conflict.txt"), "main\n");
  await git("commit", "-qam", "main change");
  // git merge 在产生冲突时以非零码退出，execFile 会直接 reject；冲突本身是本用例的前置状态。
  await git("merge", "--no-edit", "feature").catch(() => {});
  assert.deepEqual(await statusShort(), ["UU conflict.txt", "M  staged.txt"]);

  await repo.discard(root, ["conflict.txt"], false);

  assert.deepEqual(await statusShort(), ["M  staged.txt"]);
});

test("discard 已暂存时以 HEAD 覆盖索引与工作区", async () => {
  await writeFile(join(root, "staged.txt"), "rewritten\n");
  await git("add", "staged.txt");
  assert.deepEqual(await statusShort(), ["M  staged.txt"]);

  await repo.discard(root, ["staged.txt"], true);

  assert.deepEqual(await statusShort(), []);
});

test("discard 对 git 未知且不存在的路径仍报错", async () => {
  await assert.rejects(repo.discard(root, ["missing.txt"], false), /git restore failed/);
});
