// 每日运营日报 CLI（specs/web-daily-report.md §2）：oneshot 进程，由 systemd timer 每日 23:00 触发。
// 读 nginx 两份日志聚合当日指标 → 更新 seen-vids → 经飞书应用 API 发卡片（对齐 skillpie 的发送方式）。
// 环境变量（经 /opt/zcode-relay/report.env 注入）：
//   FEISHU_APP_ID / FEISHU_APP_SECRET        应用凭证（必填，缺一则跳过发送）
//   FEISHU_NOTIFY_USER_ID                    接收人 user_id（skillpie 同名语义；发群改为
//                                            FEISHU_RECEIVE_ID_TYPE=chat_id + 群 chat_id）
//   STATS_LOG / RELAY_LOG / SEEN_VIDS_FILE / REPORT_DATE 路径与日期可覆盖
// 参数：--dry-run 只打印请求体不落盘不发送；--list-chats 列出应用所在群（取 chat_id 用）。
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildDailyReportCard, buildMessageBody } from "./feishuCard.js";
import { getTenantAccessToken, listBotChats, sendInteractiveCard } from "./feishuClient.js";
import { aggregateDaily } from "./metrics.js";
import { isoDayPrefix } from "./parse.js";

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
}

const STATS_LOG_DEFAULT = "/var/log/nginx/zcode_stats.log";
const RELAY_LOG_DEFAULT = "/var/log/nginx/zcode_relay.log";
const SEEN_VIDS_DEFAULT = "/var/lib/zcode-stats/seen-vids";

async function readTextLines(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter((line) => line.length > 0);
  } catch (error) {
    // 日志文件缺失按空数据处理照常出报表（specs/web-daily-report.md §3）。
    const code = (error as NodeJS.ErrnoException).code;
    log("info", "log file unreadable, treat as empty", { path, code: code ?? String(error) });
    return [];
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const now = new Date();
  const reportDate = process.env.REPORT_DATE?.trim();
  const date = reportDate || isoDayPrefix(now);
  // REPORT_DATE 只覆盖聚合的日期过滤与 seen-vids 判定；卡片页脚的生成时间始终取当前时刻。
  const effectiveNow = reportDate ? new Date(`${date}T23:00:00`) : now;

  const [statsLines, relayLines, seenVids] = await Promise.all([
    readTextLines(process.env.STATS_LOG?.trim() || STATS_LOG_DEFAULT),
    readTextLines(process.env.RELAY_LOG?.trim() || RELAY_LOG_DEFAULT),
    readTextLines(process.env.SEEN_VIDS_FILE?.trim() || SEEN_VIDS_DEFAULT).then(
      (lines) => new Set(lines),
    ),
  ]);

  const { metrics, newVisitors } = aggregateDaily({ statsLines, relayLines, seenVids, now: effectiveNow });
  log("info", "daily metrics aggregated", { ...metrics });

  if (!dryRun && newVisitors.length > 0) {
    const seenPath = process.env.SEEN_VIDS_FILE?.trim() || SEEN_VIDS_DEFAULT;
    await mkdir(dirname(seenPath), { recursive: true });
    await appendFile(seenPath, `${newVisitors.join("\n")}\n`, "utf8");
    log("info", "seen-vids updated", { path: seenPath, appended: newVisitors.length });
  }

  const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
  const receiveId = process.env.FEISHU_NOTIFY_USER_ID?.trim() ?? "";
  const receiveIdType = process.env.FEISHU_RECEIVE_ID_TYPE?.trim() || "user_id";

  const card = buildDailyReportCard(metrics, now);

  if (args.has("--list-chats")) {
    if (!appId || !appSecret) throw new Error("--list-chats 需要 FEISHU_APP_ID / FEISHU_APP_SECRET");
    const chats = await listBotChats(await getTenantAccessToken({ appId, appSecret }));
    process.stdout.write(`${JSON.stringify(chats, null, 2)}\n`);
    return;
  }

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(receiveId ? buildMessageBody(receiveId, card) : { card }, null, 2)}\n`,
    );
    return;
  }

  // 凭证或接收人未配置：正常结束跳过发送，不视为失败（specs/web-daily-report.md §3）。
  if (!appId || !appSecret || !receiveId) {
    log("info", "feishu credentials incomplete, skip sending", {
      hasAppId: Boolean(appId),
      hasAppSecret: Boolean(appSecret),
      hasReceiveId: Boolean(receiveId),
    });
    return;
  }

  const token = await getTenantAccessToken({ appId, appSecret });
  const message = await sendInteractiveCard(token, receiveIdType, buildMessageBody(receiveId, card));
  log("info", "daily report sent", { receiveIdType, msg: message });
}

try {
  await main();
} catch (error) {
  log("error", "daily report failed", { error: String(error) });
  process.exitCode = 1;
}
