// 日志行解析（specs/web-daily-report.md §2）：纯函数，无 IO。
// zcode_stats.log 由 nginx `log_format zcode_stats` 产出（TAB 分隔，UA 在末段允许内含分隔符）：
//   $time_iso8601 \t $remote_addr \t $arg_vid \t $arg_ref \t $http_user_agent
// zcode_relay.log 为 nginx 默认 combined 格式。

export interface StatsVisit {
  timeIso: string;
  ip: string;
  /** UV 去重键：匿名 vid；缺失（理论上不发生）时按 IP 兜底。 */
  visitorKey: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** 本地日期 → nginx `$time_iso8601` 的日期前缀；stats 日志按字符串前缀过滤，避免解析时区歧义。 */
export function isoDayPrefix(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 本地日期 → nginx `$time_local` 的日期段（combined 日志形如 `[29/Sep/2026:23:00:01 +0800]`）。 */
export function nginxDayLabel(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}/${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

/** 解析 stats beacon 行；非当日或缺关键字段返回 null。 */
export function parseStatsLine(line: string, dayPrefix: string): StatsVisit | null {
  const cols = line.split("\t");
  if (cols.length < 3 || !cols[0]!.startsWith(dayPrefix)) return null;
  const ip = cols[1]!.trim();
  if (!ip) return null;
  const vid = cols[2]!.trim();
  return { timeIso: cols[0]!, ip, visitorKey: vid || `ip:${ip}` };
}

const RELAY_LINE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+) HTTP\/[\d.]+" (\d{3}) /;

export interface RelayRequest {
  method: string;
  /** 不含查询串的请求路径。 */
  path: string;
  status: number;
}

/** 解析 relay 访问日志（combined）一行；不匹配返回 null。 */
export function parseRelayLine(line: string): RelayRequest | null {
  const m = RELAY_LINE.exec(line);
  if (!m) return null;
  const rawPath = m[4]!;
  return { method: m[3]!, path: rawPath.split("?")[0]!, status: Number(m[5]) };
}
