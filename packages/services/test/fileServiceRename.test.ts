import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createFileService } from "../src/file/fileService.js";

// 文件树右键「重命名」的 Host 侧验收：
// 同目录改名、目录改名、目标已存在拒绝（防 POSIX rename 静默覆盖）、
// 非法名拒绝（分隔符 / ./.. 会把重命名变成移动或越界）、源缺失拒绝、同名幂等。

const fileService = createFileService();
let root = "";

before(async () => {
  // macOS tmpdir 位于 /var 符号链接下，先归一避免路径比较错位。
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-file-rename-")));
  await writeFile(join(root, "a.txt"), "a\n");
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "inner.txt"), "inner\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("renameEntry 同目录重命名文件并保留内容", async () => {
  await fileService.renameEntry({ path: join(root, "a.txt"), nextName: "b.txt" });
  const renamedStat = await stat(join(root, "b.txt"));
  assert.equal(renamedStat.isFile(), true);
  await assert.rejects(stat(join(root, "a.txt")));
});

test("renameEntry 支持重命名目录", async () => {
  await fileService.renameEntry({ path: join(root, "dir"), nextName: "dir2" });
  const innerStat = await stat(join(root, "dir2", "inner.txt"));
  assert.equal(innerStat.isFile(), true);
});

test("renameEntry 目标已存在时拒绝且不覆盖", async () => {
  await writeFile(join(root, "c.txt"), "c\n");
  await assert.rejects(
    fileService.renameEntry({ path: join(root, "b.txt"), nextName: "c.txt" }),
    /already exists/,
  );
  const keptStat = await stat(join(root, "c.txt"));
  assert.equal(keptStat.isFile(), true);
});

test("renameEntry 拒绝含路径分隔符或空段的新名", async () => {
  await assert.rejects(
    fileService.renameEntry({ path: join(root, "b.txt"), nextName: "sub/c.txt" }),
    /Invalid entry name/,
  );
  await assert.rejects(
    fileService.renameEntry({ path: join(root, "b.txt"), nextName: ".." }),
    /Invalid entry name/,
  );
  await assert.rejects(
    fileService.renameEntry({ path: join(root, "b.txt"), nextName: "  " }),
    /Invalid entry name/,
  );
});

test("renameEntry 源不存在时拒绝", async () => {
  await assert.rejects(
    fileService.renameEntry({ path: join(root, "missing.txt"), nextName: "x.txt" }),
    /does not exist/,
  );
});

test("renameEntry 新名与旧名一致时幂等返回", async () => {
  await fileService.renameEntry({ path: join(root, "b.txt"), nextName: "b.txt" });
  const keptStat = await stat(join(root, "b.txt"));
  assert.equal(keptStat.isFile(), true);
});
