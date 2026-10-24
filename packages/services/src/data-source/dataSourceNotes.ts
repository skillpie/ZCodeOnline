/**
 * 查数手册（人工口径/陷阱文档）落盘：data-sources/notes/<id>.md。
 * 与 schema-cache 同目录体系、同一 safeId 公式，agent 侧 store.ts 按相同
 * 公式只读。host 是唯一写者；updatedAt 取文件 mtime——写完即稳定，
 * agent 注入去重指纹（mtime+长度）据此感知手册更新并重新注入。
 * 空内容即清除文件（与「无手册」等价，注入正文回退为纯表清单）。
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DataSourceNotesResult } from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getDataSourceDataDir } from "./dataSourceConfigFile.js";

function notesFileFor(dataSourceId: string): string {
  const safeId = String(dataSourceId).replace(/[^\w-]/g, "_");
  return join(getDataSourceDataDir(), "notes", `${safeId}.md`);
}

/** 读取手册；无文件返回 { content: null, updatedAt: null }。 */
export async function readDataSourceNotesFile(
  dataSourceId: string,
): Promise<DataSourceNotesResult> {
  const filePath = notesFileFor(dataSourceId);
  try {
    const [content, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    if (!content.trim()) return { content: null, updatedAt: null };
    return { content, updatedAt: new Date(fileStat.mtimeMs).toISOString() };
  } catch {
    return { content: null, updatedAt: null };
  }
}

/** 覆盖写手册（原子写）；content 为空时清除文件。 */
export async function writeDataSourceNotesFile(
  dataSourceId: string,
  content: string | null,
): Promise<void> {
  const filePath = notesFileFor(dataSourceId);
  if (!content || !content.trim()) {
    await rm(filePath, { force: true });
    return;
  }
  await mkdir(join(getDataSourceDataDir(), "notes"), { recursive: true });
  await atomicWriteText(filePath, content);
}

/** 删除数据源时清理手册文件，防孤儿（不存在为 no-op）。 */
export async function deleteDataSourceNotesFile(dataSourceId: string): Promise<void> {
  await rm(notesFileFor(dataSourceId), { force: true });
}
