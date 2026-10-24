// 查数手册（宿主侧 data-sources/notes/<id>.md）的读写与清理语义。
// 覆盖：读写往返、空内容清除、删除数据源清理、无文件读 null、safeId 归一。
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import {
  deleteDataSourceNotesFile,
  readDataSourceNotesFile,
  writeDataSourceNotesFile,
} from "../src/data-source/dataSourceNotes.js";

// 直接驱动宿主侧文件实现（服务层是薄转发）；数据目录指到临时目录，不触碰真实 ~/.zcode。
let dataRoot: string;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "zcode-ds-notes-test-"));
  setDataBaseDir(dataRoot);
});

afterAll(async () => {
  setDataBaseDir(null);
  await rm(dataRoot, { recursive: true, force: true });
});

describe("宿主侧查数手册文件", () => {
  it("无文件与空内容都读 content: null", async () => {
    expect(await readDataSourceNotesFile("ds-none")).toEqual({
      content: null,
      updatedAt: null,
    });
    await writeDataSourceNotesFile("ds-empty", "   \n");
    expect(await readDataSourceNotesFile("ds-empty")).toEqual({
      content: null,
      updatedAt: null,
    });
  });

  it("写入后可读取，updatedAt 来自文件 mtime", async () => {
    await writeDataSourceNotesFile("ds-1", "# 手册\n租户过滤：tenant_id = 'x'");
    const result = await readDataSourceNotesFile("ds-1");
    expect(result.content).toContain("tenant_id = 'x'");
    expect(result.updatedAt).not.toBeNull();
    const fileStat = await stat(join(dataRoot, ".zcode", "v2", "data-sources", "notes", "ds-1.md"));
    expect(result.updatedAt).toBe(new Date(fileStat.mtimeMs).toISOString());
  });

  it("空内容保存即清除文件；删除数据源清理幂等", async () => {
    await writeDataSourceNotesFile("ds-2", "内容");
    await writeDataSourceNotesFile("ds-2", null);
    expect(await readDataSourceNotesFile("ds-2")).toEqual({ content: null, updatedAt: null });
    await deleteDataSourceNotesFile("ds-2");
    await expect(deleteDataSourceNotesFile("ds-2")).resolves.toBeUndefined();
  });

  it("特殊字符 id 做 safeId 归一，读写指向同一文件", async () => {
    await writeDataSourceNotesFile("id/with space", "笔记");
    const result = await readDataSourceNotesFile("id/with space");
    expect(result.content).toBe("笔记");
  });
});
