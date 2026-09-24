import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createFileService } from "../src/file/fileService.js";

// 内容搜索（searchWorkspaceContent）Host 侧验收：
// 大小写不敏感命中、行号正确、.zcodeignore 生效、二进制跳过、limit 有界（specs/command-center.md §5）。
let root = "";
const fileService = createFileService();

before(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-content-search-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(
    join(root, "src", "alpha.ts"),
    "export const alpha = 1;\n  // TODO: alpha polish\n",
  );
  await writeFile(join(root, "src", "beta.md"), "# Beta\n\nsome ALPHA content here\n");
  await writeFile(join(root, "node_modules", "dep", "index.js"), "const alpha = 2;\n");
  // 带 NUL 字节的伪 PNG：内容搜索必须按疑似二进制整只跳过。
  await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await writeFile(join(root, ".zcodeignore"), "node_modules/\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("content search matches case-insensitively with line numbers and trimmed text", async () => {
  const matches = await fileService.searchWorkspaceContent({ rootPath: root, query: "alpha" });
  const byKey = new Map(matches.map((match) => [`${match.relativePath}:${match.line}`, match]));

  assert.deepEqual([...byKey.keys()].sort(), ["src/alpha.ts:1", "src/alpha.ts:2", "src/beta.md:3"]);
  assert.equal(byKey.get("src/alpha.ts:1")?.text, "export const alpha = 1;");
  assert.equal(byKey.get("src/alpha.ts:2")?.text, "// TODO: alpha polish");
  assert.equal(byKey.get("src/beta.md:3")?.name, "beta.md");
  assert.equal(byKey.get("src/alpha.ts:1")?.path, join(root, "src", "alpha.ts"));
});

test("content search respects .zcodeignore exclusions", async () => {
  const matches = await fileService.searchWorkspaceContent({ rootPath: root, query: "alpha" });
  for (const match of matches) {
    assert.equal(match.relativePath.includes("node_modules"), false, match.relativePath);
  }
});

test("content search skips binary-looking files", async () => {
  const matches = await fileService.searchWorkspaceContent({ rootPath: root, query: "png" });
  assert.equal(
    matches.some((match) => match.relativePath === "logo.png"),
    false,
  );
});

test("content search requires every whitespace-separated term on the same line", async () => {
  const matches = await fileService.searchWorkspaceContent({
    rootPath: root,
    query: "alpha content",
  });
  assert.deepEqual(
    matches.map((match) => `${match.relativePath}:${match.line}`),
    ["src/beta.md:3"],
  );
});

test("content search caps total matches at the requested limit", async () => {
  const matches = await fileService.searchWorkspaceContent({
    rootPath: root,
    query: "alpha",
    limit: 2,
  });
  assert.equal(matches.length, 2);
});

test("content search returns empty for blank queries", async () => {
  assert.deepEqual(await fileService.searchWorkspaceContent({ rootPath: root, query: "   " }), []);
});

test("content search rejects non-string queries", async () => {
  await assert.rejects(
    fileService.searchWorkspaceContent({
      rootPath: root,
      query: 42 as unknown as string,
    }),
    /Invalid workspace content search/,
  );
});
