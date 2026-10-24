// ============================================================
// Data source schema reminder - 会话绑定数据源的表清单 + 查数手册注入
// ============================================================
// 背景：DBSchema 是表结构进入模型上下文的唯一通道，会话首次做数据分析前
// 模型都要先一次列表调用（一整次模型往返）。会话已绑定数据源时，把表名+
// 注释清单随绑定注入会话流，省掉首次列表往返；列结构不注入（全量列清单
// 体积约为表清单 10 倍），仍按需经 DBSchema table= 精确查询。
//
// 查数手册（data-sources/notes/<id>.md，数据源面板「查数手册」编辑的人工
// 口径/陷阱文档）随表清单合并注入：租户过滤、单号规则、跨表关联、统计
// 陷阱这类知识只存在于人工文档，schema 快照与列注释都覆盖不了。
//
// 去重以 messageHistory 为唯一事实源（无独立 marker）：注入前反向扫描
// 最近一条 data_source_schema 附件并比对其中记录的 data-source-id 与
// notes-fingerprint（手册 mtime+字节数）——resume/rewind/fork 重建历史后
// 扫描结果自动反映当前事实；host 保存手册后指纹变化，下一轮自动重注入，
// 无需推送通知。
import { traceContextToLogContext, type TraceContext } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import type { DbSchemaTable } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  findDataSourceById,
  readDataSourceNotes,
  readSchemaCache,
} from "../../tool/handlers/db/store.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import type { TurnRequestState } from "./turn-loop-state.js";

/** 与 db-schema.ts 的列表上限一致；超出部分提示模型用 keyword 收窄。 */
const MAX_LISTED_TABLES = 150;
/** 手册体积护栏：防超大文件吃穿上下文（DB_WIKI 实测约 35KB / 10K tokens）。 */
const MAX_NOTES_BYTES = 64_000;
const DATA_SOURCE_SCHEMA_SOURCE = "data_source_schema" as const;
const DATA_SOURCE_ID_PATTERN = /^data-source-id: (\S+)$/m;
const NOTES_FINGERPRINT_PATTERN = /^notes-fingerprint: (\S+)$/m;

export function buildDataSourceSchemaReminderBody(input: {
  dataSourceId: string;
  sourceName: string;
  sourceType: string;
  readOnly: boolean;
  fetchedAt: string;
  tables: DbSchemaTable[];
  notes?: { content: string; fingerprint: string } | null;
}): string {
  const tables = input.tables;
  const lines = tables
    .slice(0, MAX_LISTED_TABLES)
    .map((table) => {
      const kind = `[${table.kind}]`;
      return table.comment?.trim()
        ? `${table.name} ${kind} ${table.comment.trim()}`
        : `${table.name} ${kind}`;
    });
  const omitted = tables.length - Math.min(tables.length, MAX_LISTED_TABLES);
  const linesBlock = [
    ...lines,
    ...(omitted > 0
      ? [`(${omitted} more tables not listed — call DBSchema with a keyword to narrow down)`]
      : []),
  ].join("\n");

  const notes = input.notes;
  const notesBlock = notes
    ? [
        "",
        "## Data source notes (human-maintained query handbook)",
        notes.content.trimEnd(),
      ].join("\n")
    : "";
  const closing = [
    "Pick tables from the list above when composing SQL, then call DBSchema with table=<name> to load exact column names and types; a plain DBSchema listing call is unnecessary while this list matches the bound data source.",
    // 手册是人工快照会过期，列注释来自内省快照：冲突裁决规则写给模型。
    ...(notes
      ? ["If the notes conflict with column comments from DBSchema, trust the DBSchema result."]
      : []),
  ].join("\n");

  return [
    `The data source for this conversation is now "${input.sourceName}" (${input.sourceType}${input.readOnly ? ", read-only" : ", read-write"}).`,
    `data-source-id: ${input.dataSourceId}`,
    `notes-fingerprint: ${notes ? notes.fingerprint : "none"}`,
    `Local schema snapshot synced at ${input.fetchedAt} — ${tables.length} tables (name [kind] comment):`,
    "",
    linesBlock,
    notesBlock,
    "",
    closing,
  ].join("\n");
}

/** 从附件正文提取注入时记录的数据源 id；无标记行返回 undefined。 */
export function extractDataSourceIdFromReminder(content: string): string | undefined {
  return DATA_SOURCE_ID_PATTERN.exec(content)?.[1];
}

/** 从附件正文提取手册指纹（无手册时为 "none"）；无标记行返回 undefined。 */
export function extractNotesFingerprintFromReminder(content: string): string | undefined {
  return NOTES_FINGERPRINT_PATTERN.exec(content)?.[1];
}

/** 读取手册并产出注入用正文（超护栏截断尾部并注明）。 */
async function loadNotesForInjection(
  dataSourceId: string,
): Promise<{ content: string; fingerprint: string } | null> {
  const notes = await readDataSourceNotes(dataSourceId);
  if (!notes) return null;
  const bytes = Buffer.byteLength(notes.content, "utf-8");
  const truncated =
    bytes > MAX_NOTES_BYTES
      ? `${notes.content.slice(0, MAX_NOTES_BYTES)}\n\n(notes truncated at ${MAX_NOTES_BYTES} bytes — ask the user to shorten the data source notes)`
      : notes.content;
  return { content: truncated, fingerprint: `${notes.mtimeMs}-${bytes}` };
}

/**
 * 绑定与最近一次注入一致（id 与手册指纹都相同）时返回 true。
 * 反向扫描到最近一条即停：历史里可能有多条（A→B→A 切换、手册更新），
 * 只有最后一条代表当前生效的注入。
 */
function isSchemaReminderUpToDate(
  entries: readonly RuntimeMessageEntry[],
  dataSourceId: string,
  notesFingerprint: string,
): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (!isRuntimeAttachmentEntry(entry)) continue;
    if (entry.metadata.source !== DATA_SOURCE_SCHEMA_SOURCE) continue;
    return (
      extractDataSourceIdFromReminder(entry.content) === dataSourceId &&
      extractNotesFingerprintFromReminder(entry.content) === notesFingerprint
    );
  }
  return false;
}

/**
 * 会话数据源绑定变更时注入表清单（幂等）。
 * - 绑定未变且手册未更新：no-op；绑定解除（undefined）：no-op（旧清单保留为
 *   历史事实，DB 工具回退 activeId 时模型经 DBSchema 自行发现，与注入前行为一致）。
 * - 数据源未配置或快照未同步：跳过注入且不报错——工具调用时已有带清单的
 *   引导错误，注入层不再制造第二条错误路径。
 * - 持久化失败仅告警：注入是优化项，会话恢复后扫描不到附件会自动重注入，
 *   不能因落盘失败拖垮整个轮。
 */
export async function injectDataSourceSchemaReminder(
  runtime: AgentRuntimeInternal,
  dataSourceId: string | undefined,
  traceContext: TraceContext,
  turnRequestState?: TurnRequestState,
): Promise<void> {
  if (!dataSourceId?.trim()) return;
  // 指纹先行：绑定未变但手册更新时也要重注入（先读手册再比对）。
  const notes = await loadNotesForInjection(dataSourceId);
  const notesFingerprint = notes ? notes.fingerprint : "none";
  if (
    isSchemaReminderUpToDate(
      runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
      dataSourceId,
      notesFingerprint,
    )
  ) {
    return;
  }

  const resolved = await findDataSourceById(dataSourceId);
  if (!resolved) {
    runtime.logger?.debug("Data source schema reminder skipped: source not found", {
      ...traceContextToLogContext(traceContext),
      dataSourceId,
      event: "data_source_schema_reminder.skipped",
      module: "core.runtime",
      reason: "source_not_found",
    });
    return;
  }
  const cache = await readSchemaCache(resolved.config.id);
  if (!cache || cache.tables.length === 0) {
    // 快照未同步：不注入也不阻塞。后续轮绑定不变仍会重试（本地文件读，代价可忽略）。
    runtime.logger?.debug("Data source schema reminder skipped: no synced schema", {
      ...traceContextToLogContext(traceContext),
      dataSourceId,
      event: "data_source_schema_reminder.skipped",
      module: "core.runtime",
      reason: "schema_not_synced",
    });
    return;
  }

  const entry = systemReminderAttachmentEntry(
    DATA_SOURCE_SCHEMA_SOURCE,
    buildDataSourceSchemaReminderBody({
      dataSourceId: resolved.config.id,
      fetchedAt: cache.fetchedAt,
      notes,
      readOnly: resolved.config.readOnly,
      sourceName: resolved.view.name,
      sourceType: resolved.view.type,
      tables: cache.tables,
    }),
  );
  try {
    await persistRuntimeReminderMessage.call(runtime, entry, traceContext);
  } catch (error) {
    runtime.logger?.warn("Data source schema reminder persistence failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "data_source_schema_reminder.persist_failed",
      module: "core.runtime",
    });
  }
  runtime.messageHistory.addAttachment(DATA_SOURCE_SCHEMA_SOURCE, entry.content);
  // drain 注入发生在 turnRequestState 快照之后，必须同步追加到进行中轮的条目，
  // 否则本轮后续请求看不到清单；turn 开始路径传入 undefined（快照尚未创建）。
  if (turnRequestState) {
    appendTurnRequestEntries(turnRequestState, [entry]);
  }
  runtime.logger?.debug("Data source schema reminder injected", {
    ...traceContextToLogContext(traceContext),
    dataSourceId,
    event: "data_source_schema_reminder.injected",
    module: "core.runtime",
    notesBytes: notes ? Buffer.byteLength(notes.content, "utf-8") : 0,
    status: "completed",
    tableCount: cache.tables.length,
  });
}
