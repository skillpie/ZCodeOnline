/**
 * 会话级数据源绑定的宿主侧持久化（用户决策：绑定走宿主存储，桌面端与 Web 端
 * 共用同一份；删除会话时由宿主清理，防止绑定无限增长）。
 *
 * 文件：{dataDir}/data-sources/session-bindings.json，结构
 * { version: 1, bindings: Record<sessionId, dataSourceId> }。
 * sessionId 全局唯一，平铺不分 workspace 桶——Web 端（remote identity）与
 * 桌面端（本地路径）对同一会话的 key 天然一致，跨端共享。
 * 与 config.json 分离：数据源 CRUD 不会连带重写绑定，坏文件整体回退空表。
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";

const BINDINGS_VERSION = 2;

interface SessionBindingsFile {
  version: number;
  /** sessionId → dataSourceId */
  bindings: Record<string, string>;
}

function defaultFile(): SessionBindingsFile {
  return { version: BINDINGS_VERSION, bindings: {} };
}

function getSessionBindingsFile(): string {
  return join(getAppConfigDir(), "data-sources", "session-bindings.json");
}

async function readBindingsFile(): Promise<SessionBindingsFile> {
  try {
    const raw = await readFile(getSessionBindingsFile(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionBindingsFile> | null;
    // version 2 之前的 workspace 分桶结构（v1）在跨端场景 key 不一致，直接作废重来。
    if (!parsed || typeof parsed !== "object" || parsed.version !== BINDINGS_VERSION) {
      return defaultFile();
    }
    const bindings: Record<string, string> = {};
    for (const [sessionId, dataSourceId] of Object.entries(parsed.bindings ?? {})) {
      if (typeof sessionId === "string" && typeof dataSourceId === "string" && dataSourceId) {
        bindings[sessionId] = dataSourceId;
      }
    }
    return { version: BINDINGS_VERSION, bindings };
  } catch {
    return defaultFile();
  }
}

async function writeBindingsFile(file: SessionBindingsFile): Promise<void> {
  await mkdir(join(getAppConfigDir(), "data-sources"), { recursive: true });
  await atomicWriteText(
    getSessionBindingsFile(),
    JSON.stringify({ ...file, version: BINDINGS_VERSION }, null, 2),
  );
}

export async function readSessionDataSourceBinding(sessionId: string): Promise<string | null> {
  const file = await readBindingsFile();
  return file.bindings[sessionId] ?? null;
}

/** 写入/清除（null）单个会话绑定。 */
export async function writeSessionDataSourceBinding(
  sessionId: string,
  dataSourceId: string | null,
): Promise<void> {
  const file = await readBindingsFile();
  const bindings = { ...file.bindings };
  if (dataSourceId) bindings[sessionId] = dataSourceId;
  else delete bindings[sessionId];
  await writeBindingsFile({ version: BINDINGS_VERSION, bindings });
}

/** 会话删除时清理绑定（幂等；不存在的会话为 no-op）。 */
export async function deleteSessionDataSourceBinding(sessionId: string): Promise<void> {
  await writeSessionDataSourceBinding(sessionId, null);
}
