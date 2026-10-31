/**
 * 会话级数据源绑定的宿主侧持久化（用户决策：绑定走宿主存储，桌面端与 Web 端
 * 共用同一份；删除会话时由宿主清理，防止绑定无限增长）。
 *
 * 文件：{dataDir}/data-sources/session-bindings.json，结构
 * { version: 1, bindings: Record<sessionId, dataSourceId> }。
 * sessionId 全局唯一，平铺不分 workspace 桶——Web 端（remote identity）与
 * 桌面端（本地路径）对同一会话的 key 天然一致，跨端共享。
 * 与 config.json 分离：数据源 CRUD 不会连带重写绑定，坏文件整体回退空表。
 *
 * 写入经进程内串行队列：写入是读-改-写，两个并发写（多窗口同时改不同会话）
 * 交替执行时后写会用旧快照覆盖前写（丢绑定），必须排队串行；同值重复写被
 * diff-skip 掉，信封自愈回写与 UI 显式选择双路径不会造成文件抖动。
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";
import { loadDataSourceConfigFile } from "./dataSourceConfigFile.js";

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

/** 读-改-写必须串行：队列吞掉前序失败，后续写不受污染。 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}

export async function readSessionDataSourceBinding(sessionId: string): Promise<string | null> {
  const file = await readBindingsFile();
  return file.bindings[sessionId] ?? null;
}

/**
 * 门控回退专用：绑定存在且数据源仍在配置中才返回。悬挂绑定（源已删除）按
 * 未选择处理（specs/data-source.md §7.5 场景 4），与渲染层投影列表校验同语义。
 */
export async function resolveVerifiedSessionDataSourceBinding(
  sessionId: string,
): Promise<string | null> {
  const bindingId = await readSessionDataSourceBinding(sessionId);
  if (!bindingId) return null;
  const file = await loadDataSourceConfigFile();
  return file.dataSources.some((item) => item.id === bindingId) ? bindingId : null;
}

/** 写入/清除（null）单个会话绑定；同值幂等跳过，避免信封自愈与 UI 双路径反复落盘。 */
export async function writeSessionDataSourceBinding(
  sessionId: string,
  dataSourceId: string | null,
): Promise<void> {
  await enqueueWrite(async () => {
    const file = await readBindingsFile();
    if ((file.bindings[sessionId] ?? null) === (dataSourceId ?? null)) return;
    const bindings = { ...file.bindings };
    if (dataSourceId) bindings[sessionId] = dataSourceId;
    else delete bindings[sessionId];
    await writeBindingsFile({ version: BINDINGS_VERSION, bindings });
  });
}

/** 会话删除时清理绑定（幂等；不存在的会话为 no-op）。 */
export async function deleteSessionDataSourceBinding(sessionId: string): Promise<void> {
  await writeSessionDataSourceBinding(sessionId, null);
}

/** 数据源删除时清理所有指向它的绑定（幂等；无引用为 no-op）。 */
export async function deleteSessionDataSourceBindingsForDataSource(
  dataSourceId: string,
): Promise<void> {
  await enqueueWrite(async () => {
    const file = await readBindingsFile();
    const sessionIds = Object.keys(file.bindings).filter(
      (sessionId) => file.bindings[sessionId] === dataSourceId,
    );
    if (sessionIds.length === 0) return;
    const bindings = { ...file.bindings };
    for (const sessionId of sessionIds) delete bindings[sessionId];
    await writeBindingsFile({ version: BINDINGS_VERSION, bindings });
  });
}
