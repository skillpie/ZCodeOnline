/**
 * 会话级数据源绑定的宿主侧持久化（用户决策：绑定走宿主存储，桌面端与 Web 端
 * 共用同一份；删除会话时由宿主清理，防止绑定无限增长）。
 *
 * 文件：{dataDir}/data-sources/session-bindings.json，结构
 * { version: 1, bindings: Record<sessionId, dataSourceId> }。
 * 与 config.json 分离：数据源 CRUD 不会连带重写绑定，坏文件整体回退空表。
 * key 惯例与项目存储一致：workspaceIdentity?.trim() || workspacePath。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";

const BINDINGS_VERSION = 1;

interface SessionBindingsFile {
  version: number;
  /** workspaceKey → (sessionId → dataSourceId) */
  workspaces: Record<string, Record<string, string>>;
}

function defaultFile(): SessionBindingsFile {
  return { version: BINDINGS_VERSION, workspaces: {} };
}

function getSessionBindingsFile(): string {
  return join(getAppConfigDir(), "data-sources", "session-bindings.json");
}

function normalizeWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

async function readBindingsFile(): Promise<SessionBindingsFile> {
  try {
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(getSessionBindingsFile(), "utf-8"),
    );
    const parsed = JSON.parse(raw) as Partial<SessionBindingsFile> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== BINDINGS_VERSION ||
      typeof parsed.workspaces !== "object" ||
      parsed.workspaces === null
    ) {
      return defaultFile();
    }
    const workspaces: Record<string, Record<string, string>> = {};
    for (const [key, bindings] of Object.entries(parsed.workspaces)) {
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) continue;
      const clean: Record<string, string> = {};
      for (const [sessionId, dataSourceId] of Object.entries(bindings)) {
        if (typeof sessionId === "string" && typeof dataSourceId === "string" && dataSourceId) {
          clean[sessionId] = dataSourceId;
        }
      }
      workspaces[key] = clean;
    }
    return { version: BINDINGS_VERSION, workspaces };
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

export async function readSessionDataSourceBinding(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
): Promise<string | null> {
  const file = await readBindingsFile();
  const key = normalizeWorkspaceKey(workspacePath, workspaceIdentity);
  return file.workspaces[key]?.[sessionId] ?? null;
}

/** 写入/清除（null）单个会话绑定。 */
export async function writeSessionDataSourceBinding(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
  dataSourceId: string | null,
): Promise<void> {
  const file = await readBindingsFile();
  const key = normalizeWorkspaceKey(workspacePath, workspaceIdentity);
  const bindings = { ...file.workspaces[key] };
  if (dataSourceId) bindings[sessionId] = dataSourceId;
  else delete bindings[sessionId];
  const workspaces = { ...file.workspaces };
  if (Object.keys(bindings).length > 0) workspaces[key] = bindings;
  else delete workspaces[key];
  await writeBindingsFile({ version: BINDINGS_VERSION, workspaces });
}

/** 会话删除时清理绑定（幂等；不存在的会话为 no-op）。 */
export async function deleteSessionDataSourceBinding(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
): Promise<void> {
  await writeSessionDataSourceBinding(workspacePath, workspaceIdentity, sessionId, null);
}
