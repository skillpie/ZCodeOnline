import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createFileService } from "../src/file/fileService.js";

// 预览面板编辑保存（IFileService.writeTextFile）Host 侧验收：
// UTF-8 覆写、目录拒绝、缺失文件拒绝、超限拒绝。
let root = "";
const fileService = createFileService();

before(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-write-text-"));
  await writeFile(join(root, "pytest.ini"), "[pytest]\ntestpaths = tests\n");
  await mkdir(join(root, "sub"), { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("writeTextFile overwrites an existing file with utf-8 content", async () => {
  await fileService.writeTextFile({
    path: join(root, "pytest.ini"),
    content: "[pytest]\nmarkers =\n  scm: cross-domain\n",
  });

  const reread = await fileService.readTextFile({ path: join(root, "pytest.ini") });
  assert.equal(reread.content, "[pytest]\nmarkers =\n  scm: cross-domain\n");
  assert.equal(reread.isBinary, false);
});

test("writeTextFile rejects directories and missing files", async () => {
  await assert.rejects(
    fileService.writeTextFile({ path: join(root, "sub"), content: "x" }),
    /Path is not a file/,
  );
  await assert.rejects(
    fileService.writeTextFile({ path: join(root, "missing.ini"), content: "x" }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  // 拒绝写入后不得把缺失路径落成新文件。
  await assert.rejects(stat(join(root, "missing.ini")));
});

test("writeTextFile rejects content beyond the write limit", async () => {
  await assert.rejects(
    fileService.writeTextFile({
      path: join(root, "pytest.ini"),
      content: "a".repeat(1024 * 1024 + 1),
    }),
    /text write limit/,
  );
});
