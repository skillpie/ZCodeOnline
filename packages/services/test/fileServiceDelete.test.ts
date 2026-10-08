import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createFileService } from "../src/file/fileService.js";

// 文件树右键「删除」的 Host 侧验收：
// 文件删除、目录递归删除、缺失路径拒绝、文件系统根拒绝（rm 递归的最后防线）、空路径拒绝。

const fileService = createFileService();
let root = "";

before(async () => {
  // macOS tmpdir 位于 /var 符号链接下，先归一避免路径比较错位。
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-file-delete-")));
  await writeFile(join(root, "a.txt"), "a\n");
  await mkdir(join(root, "dir", "nested"), { recursive: true });
  await writeFile(join(root, "dir", "nested", "inner.txt"), "inner\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("deleteEntry 删除单个文件", async () => {
  await fileService.deleteEntry({ path: join(root, "a.txt") });
  await assert.rejects(stat(join(root, "a.txt")));
});

test("deleteEntry 递归删除目录及其内容", async () => {
  await fileService.deleteEntry({ path: join(root, "dir") });
  await assert.rejects(stat(join(root, "dir")));
});

test("deleteEntry 对不存在的路径拒绝", async () => {
  await assert.rejects(
    fileService.deleteEntry({ path: join(root, "missing.txt") }),
    /does not exist/,
  );
});

test("deleteEntry 拒绝文件系统根与空路径", async () => {
  await assert.rejects(fileService.deleteEntry({ path: "/" }), /Refusing to delete/);
  await assert.rejects(fileService.deleteEntry({ path: "   " }), /Refusing to delete/);
});
