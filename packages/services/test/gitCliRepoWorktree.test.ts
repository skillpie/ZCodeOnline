import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { afterAll as after, beforeAll as before, test } from "vitest";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

// 分支切换器新增的 worktree 能力。git 本身是唯一事实：addWorktree 负责把分支检出为
// 主树 .worktrees/ 下的 linked worktree 并幂等写 .git/info/exclude，removeWorktree
// 只允许删除注册表内的 linked worktree（clean 直接删、dirty 阻止、目录丢失走 prune）。
// 验收：创建/列表/移除的路径与 issue 翻译、目录名净化、当前 workspace 识别。

const execFileAsync = promisify(execFile);
const repo = createGitCliRepo();

let root = "";
let worktreesDir = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

async function createBranch(name: string): Promise<void> {
  await git("branch", name);
}

function issueCodes(result: { issues: Array<{ code: string }> }): string[] {
  return result.issues.map((issue) => issue.code);
}

before(async () => {
  // macOS 的 tmpdir 位于 /var 符号链接下，git worktree list 输出 realpath 形式，
  // 这里先归一，保证路径断言与 isCurrentWorkspace 判定使用同一形式。
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-worktree-")));
  worktreesDir = join(root, ".worktrees");
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await writeFile(join(root, "a.txt"), "a\n");
  await git("add", "a.txt");
  await git("commit", "-qm", "init");
  await createBranch("feature/one");
  await createBranch("feature/two");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("listWorktrees 在新仓库返回空列表并给出主树锚点", async () => {
  const result = await repo.listWorktrees(root);

  assert.deepEqual(result.worktrees, []);
  assert.equal(result.mainTreeRoot, root);
  assert.equal(result.worktreeBaseDir, join(root, ".worktrees"));
});

test("addWorktree 检出已有分支到 .worktrees 并幂等写入 info/exclude", async () => {
  const result = await repo.addWorktree(root, { branchName: "feature/one" });

  assert.equal(result.ok, true);
  assert.equal(result.worktree?.branchName, "feature/one");
  assert.equal(result.worktree?.isMain, false);
  assert.equal(result.worktree?.path, join(worktreesDir, "feature-one"));

  const exclude = await readFileText(join(root, ".git", "info", "exclude"));
  assert.ok(exclude.split(/\r?\n/).includes(".worktrees/"));

  const list = await repo.listWorktrees(root);
  assert.deepEqual(
    list.worktrees.map((entry) => entry.branchName),
    ["feature/one"],
  );

  // 幂等：再次创建（如另一分支）不重复追加 exclude 行。
  await repo.addWorktree(root, { newBranchName: "feature/from-head" });
  const excludeAfterSecond = await readFileText(join(root, ".git", "info", "exclude"));
  assert.equal(
    excludeAfterSecond.split(/\r?\n/).filter((line) => line.trim() === ".worktrees/").length,
    1,
  );
});

test("addWorktree 用 newBranchName 基于 HEAD 建分支并检出", async () => {
  const result = await repo.addWorktree(root, { newBranchName: "feature/from-head-2" });

  assert.equal(result.ok, true);
  assert.equal(result.worktree?.branchName, "feature/from-head-2");
  const branches = await git("branch", "--list", "feature/from-head-2");
  assert.ok(branches.includes("feature/from-head-2"));
});

test("addWorktree 用 newBranchStartPoint 基于指定分支建并行副本", async () => {
  // 在 feature/base 上制造一个领先 main 的提交；并行副本应从该起点开始而非当前 HEAD。
  await git("checkout", "-q", "-b", "feature/base");
  await writeFile(join(root, "base.txt"), "base\n");
  await git("add", "base.txt");
  await git("commit", "-qm", "base work");
  await git("checkout", "-q", "main");

  const result = await repo.addWorktree(root, {
    newBranchName: "feature/base-copy",
    newBranchStartPoint: "feature/base",
  });

  assert.equal(result.ok, true);
  assert.equal(result.worktree?.branchName, "feature/base-copy");
  const baseHeadSha = (await git("rev-parse", "feature/base")).trim();
  const worktreeHead = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: result.worktree?.path,
  });
  assert.equal(worktreeHead.stdout.trim(), baseHeadSha);
  await access(join(result.worktree?.path ?? "", "base.txt"));

  // 起点引用不存在 → branch-not-found。
  const missingStart = await repo.addWorktree(root, {
    newBranchName: "feature/never",
    newBranchStartPoint: "no-such-ref",
  });
  assert.equal(missingStart.ok, false);
  assert.deepEqual(issueCodes(missingStart), ["branch-not-found"]);
});

test("addWorktree 的 directoryName 与分支名解耦，目录名独立净化与查重", async () => {
  // 目录名走独立输入：目录 fengqun-scm-123456，分支 feat/123456——两者不同名。
  const created = await repo.addWorktree(root, {
    newBranchName: "feat/123456",
    directoryName: "fengqun-scm-123456",
  });

  assert.equal(created.ok, true);
  assert.equal(created.worktree?.path, join(worktreesDir, "fengqun-scm-123456"));
  assert.equal(created.worktree?.branchName, "feat/123456");

  // 目录名独立查重：换分支名但目录同名 → worktree-name-conflict。
  const dirConflict = await repo.addWorktree(root, {
    newBranchName: "feat/654321",
    directoryName: "fengqun-scm-123456",
  });
  assert.equal(dirConflict.ok, false);
  assert.deepEqual(issueCodes(dirConflict), ["worktree-name-conflict"]);

  // 检出已有分支时同样可用独立目录名。
  await createBranch("feature/existing-for-dir");
  const existingBranch = await repo.addWorktree(root, {
    branchName: "feature/existing-for-dir",
    directoryName: "dir-for-existing",
  });
  assert.equal(existingBranch.ok, true);
  assert.equal(existingBranch.worktree?.path, join(worktreesDir, "dir-for-existing"));
  assert.equal(existingBranch.worktree?.branchName, "feature/existing-for-dir");

  // 净化规则同样作用于独立目录名（`\ /` 折叠、非法字符剔除）。
  const sanitized = await repo.addWorktree(root, {
    newBranchName: "feat/222333",
    directoryName: "weird\\dir/name",
  });
  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.worktree?.path, join(worktreesDir, "weird-dir-name"));
});

test("addWorktree 对分支名做目录名净化", async () => {
  // Git ref 允许 `/` 与结尾 `.lock` 之外的多数标点；这里用合法嵌套分支验证 `/` → `-`。
  await createBranch("feature/nested/name");
  const result = await repo.addWorktree(root, { branchName: "feature/nested/name" });

  assert.equal(result.ok, true);
  assert.equal(result.worktree?.path, join(worktreesDir, "feature-nested-name"));
});

test("addWorktree 目录名冲突、分支缺失、新分支重名分别返回对应 issue", async () => {
  // 目录已存在（未注册的残留目录）→ worktree-name-conflict。
  await mkdir(join(worktreesDir, "feature-two"), { recursive: true });
  const conflict = await repo.addWorktree(root, { branchName: "feature/two" });
  assert.equal(conflict.ok, false);
  assert.deepEqual(issueCodes(conflict), ["worktree-name-conflict"]);
  await rm(join(worktreesDir, "feature-two"), { recursive: true, force: true });

  // 分支不存在 → branch-not-found。
  const missingBranch = await repo.addWorktree(root, { branchName: "no-such-branch" });
  assert.equal(missingBranch.ok, false);
  assert.deepEqual(issueCodes(missingBranch), ["branch-not-found"]);

  // newBranchName 与已有分支重名 → branch-already-exists。
  const duplicate = await repo.addWorktree(root, { newBranchName: "feature/one" });
  assert.equal(duplicate.ok, false);
  assert.deepEqual(issueCodes(duplicate), ["branch-already-exists"]);

  // 分支名不合法（`~` 是 Git ref 非法字符）→ invalid-branch-name。
  const invalid = await repo.addWorktree(root, { branchName: "bad~branch" });
  assert.equal(invalid.ok, false);
  assert.deepEqual(issueCodes(invalid), ["invalid-branch-name"]);
});

test("addWorktree 对已在其他 worktree 检出的分支返回 branch-in-other-worktree", async () => {
  // 在 .worktrees 之外用 git CLI 手工创建 worktree 占用自备分支：目录名不冲突，
  // 阻断发生在 git worktree add 本身，验证原生报错被翻译成 branch-in-other-worktree。
  await createBranch("feature/ext-checkout");
  const externalDir = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-worktree-ext-")));
  try {
    await git("worktree", "add", externalDir, "feature/ext-checkout");
    const blocked = await repo.addWorktree(root, { branchName: "feature/ext-checkout" });

    assert.equal(blocked.ok, false);
    assert.deepEqual(issueCodes(blocked), ["branch-in-other-worktree"]);
  } finally {
    await git("worktree", "remove", "--force", externalDir);
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("removeWorktree 对 clean worktree 删除目录与注册，对 dirty worktree 阻止", async () => {
  // 各测试自备分支，避免与前序用例留下的 worktree 相互污染。
  await createBranch("feature/clean-e2e");
  await createBranch("feature/dirty-e2e");

  const added = await repo.addWorktree(root, { branchName: "feature/clean-e2e" });
  assert.equal(added.ok, true);
  const worktreePath = added.worktree?.path ?? "";

  const removed = await repo.removeWorktree(root, worktreePath);
  assert.equal(removed.ok, true);
  assert.equal(removed.worktree, null);
  await assert.rejects(access(worktreePath), /ENOENT/);

  const list = await repo.listWorktrees(root);
  assert.ok(!list.worktrees.some((entry) => entry.path === worktreePath));

  // dirty：worktree 内出现未提交更改后拒绝移除，目录保持原样。
  const dirtyTarget = await repo.addWorktree(root, { branchName: "feature/dirty-e2e" });
  assert.equal(dirtyTarget.ok, true);
  const dirtyPath = dirtyTarget.worktree?.path ?? "";
  await writeFile(join(dirtyPath, "a.txt"), "changed\n");

  const blocked = await repo.removeWorktree(root, dirtyPath);
  assert.equal(blocked.ok, false);
  assert.deepEqual(issueCodes(blocked), ["worktree-dirty"]);
  await access(dirtyPath);
});

test("removeWorktree 对目录被外部删除的悬空注册走 prune 收尾", async () => {
  const added = await repo.addWorktree(root, { newBranchName: "feature/stale" });
  assert.equal(added.ok, true);
  const worktreePath = added.worktree?.path ?? "";
  await rm(worktreePath, { recursive: true, force: true });

  const removed = await repo.removeWorktree(root, worktreePath);
  assert.equal(removed.ok, true);

  const list = await repo.listWorktrees(root);
  assert.ok(!list.worktrees.some((entry) => entry.path === worktreePath));
});

test("removeWorktree 拒绝注册表之外的路径与主树", async () => {
  const arbitrary = await repo.removeWorktree(root, join(root, "not-a-worktree"));
  assert.equal(arbitrary.ok, false);
  assert.deepEqual(issueCodes(arbitrary), ["worktree-not-found"]);

  const mainTree = await repo.removeWorktree(root, root);
  assert.equal(mainTree.ok, false);
  assert.deepEqual(issueCodes(mainTree), ["worktree-not-found"]);
});

test("renameWorktree 同步改分支名并把目录移到净化名下", async () => {
  const added = await repo.addWorktree(root, { newBranchName: "feature/rename-src" });
  assert.equal(added.ok, true);
  const oldPath = added.worktree?.path ?? "";

  const renamed = await repo.renameWorktree(root, oldPath, "feature/renamed-nice");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.worktree?.branchName, "feature/renamed-nice");
  assert.equal(renamed.worktree?.path, join(worktreesDir, "feature-renamed-nice"));

  // 旧目录不在、新目录在、旧分支消失、新分支存在且 HEAD 不变。
  await assert.rejects(access(oldPath), /ENOENT/);
  const oldBranches = await git("branch", "--list", "feature/rename-src");
  assert.equal(oldBranches.trim(), "");
  const list = await repo.listWorktrees(root);
  assert.ok(list.worktrees.some((entry) => entry.branchName === "feature/renamed-nice"));

  // 名称未变时重复提交是幂等成功（部分失败后的重试自愈路径）。
  const renamedAgain = await repo.renameWorktree(
    root,
    renamed.worktree?.path ?? "",
    "feature/renamed-nice",
  );
  assert.equal(renamedAgain.ok, true);

  await repo.removeWorktree(root, renamed.worktree?.path ?? "");
});

test("renameWorktree 对重名分支、目录冲突、非法名、未知路径分别返回 issue", async () => {
  const added = await repo.addWorktree(root, { newBranchName: "feature/rename-conflict" });
  assert.equal(added.ok, true);
  const worktreePath = added.worktree?.path ?? "";

  // 目标分支名已被其它分支占用 → branch-already-exists。
  await createBranch("feature/occupied");
  const branchConflict = await repo.renameWorktree(root, worktreePath, "feature/occupied");
  assert.equal(branchConflict.ok, false);
  assert.deepEqual(issueCodes(branchConflict), ["branch-already-exists"]);

  // 目标目录已被残留目录占用 → worktree-name-conflict。
  // 目录名是净化后的分支名（`/` → `-`），残留目录也要按净化名构造。
  await mkdir(join(worktreesDir, "feature-rename-dir-conflict"), { recursive: true });
  const dirConflict = await repo.renameWorktree(root, worktreePath, "feature/rename-dir-conflict");
  assert.equal(dirConflict.ok, false);
  assert.deepEqual(issueCodes(dirConflict), ["worktree-name-conflict"]);
  await rm(join(worktreesDir, "feature-rename-dir-conflict"), { recursive: true, force: true });

  // 分支名不合法 → invalid-branch-name。
  const invalid = await repo.renameWorktree(root, worktreePath, "bad~name");
  assert.equal(invalid.ok, false);
  assert.deepEqual(issueCodes(invalid), ["invalid-branch-name"]);

  // 注册表之外的路径 → worktree-not-found；主树同理。
  const arbitrary = await repo.renameWorktree(root, join(root, "nope"), "feature/x");
  assert.equal(arbitrary.ok, false);
  assert.deepEqual(issueCodes(arbitrary), ["worktree-not-found"]);
  const mainTree = await repo.renameWorktree(root, root, "feature/x");
  assert.equal(mainTree.ok, false);
  assert.deepEqual(issueCodes(mainTree), ["worktree-not-found"]);

  await repo.removeWorktree(root, worktreePath);
});

test("listWorktrees 把当前 workspace 识别为当前 worktree", async () => {
  // 把当前 workspace 切到某个 worktree 内再列表：该行标记 isCurrentWorkspace。
  const added = await repo.addWorktree(root, { newBranchName: "feature/current-marker" });
  assert.equal(added.ok, true);
  const worktreePath = added.worktree?.path ?? "";

  const fromWorktree = await repo.listWorktrees(worktreePath);
  const current = fromWorktree.worktrees.find((entry) => entry.isCurrentWorkspace);
  assert.ok(current);
  assert.equal(current.path, worktreePath);
  // 从 worktree 内创建时锚点仍是主树。
  assert.equal(fromWorktree.mainTreeRoot, root);

  await repo.removeWorktree(worktreePath, worktreePath);
});

async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}
