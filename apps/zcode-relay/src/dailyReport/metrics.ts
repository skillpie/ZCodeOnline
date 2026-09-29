// 当日指标聚合（specs/web-daily-report.md §1 口径）：纯函数，输入日志行集合与 seen-vids，输出指标与新访客增量。
import { type StatsVisit, isoDayPrefix, nginxDayLabel, parseRelayLine, parseStatsLine } from "./parse.js";

export interface DailyMetrics {
  /** 统计日期（本地 YYYY-MM-DD）。 */
  date: string;
  pv: number;
  uv: number;
  newVisitors: number;
  pairCount: number;
  tunnelConnections: number;
  activeHosts: number;
}

export interface AggregateInput {
  statsLines: string[];
  relayLines: string[];
  seenVids: ReadonlySet<string>;
  now: Date;
}

export interface AggregateResult {
  metrics: DailyMetrics;
  /** 当日首次出现的访客键，调用方负责落盘到 seen-vids。 */
  newVisitors: string[];
}

export function aggregateDaily({ statsLines, relayLines, seenVids, now }: AggregateInput): AggregateResult {
  const date = isoDayPrefix(now);
  const dayLabel = nginxDayLabel(now);

  const visitors = new Set<string>();
  let pv = 0;
  for (const line of statsLines) {
    const visit: StatsVisit | null = parseStatsLine(line, date);
    if (!visit) continue;
    pv += 1;
    visitors.add(visit.visitorKey);
  }

  let pairCount = 0;
  let tunnelConnections = 0;
  const hosts = new Set<string>();
  for (const line of relayLines) {
    // combined 的 $time_local 含空格偏移，按 `[日/Mon/YYYY` 前缀做当日过滤。
    if (!line.includes(`[${dayLabel}`)) continue;
    const req = parseRelayLine(line);
    if (!req) continue;
    // 配对换凭证：仅成功（2xx）计一次，失败重试不算有效配对。
    if (req.method === "POST" && req.path === "/api/v1/pair" && req.status >= 200 && req.status < 300) {
      pairCount += 1;
      continue;
    }
    // 浏览器隧道接入：WS 升级（101），路径 /ws/tunnel/:hostId；重连会计次，活跃宿主按 hostId 去重。
    if (req.status === 101 && req.path.startsWith("/ws/tunnel/")) {
      const hostId = req.path.slice("/ws/tunnel/".length);
      if (hostId) {
        tunnelConnections += 1;
        hosts.add(hostId);
      }
    }
  }

  const newVisitors = [...visitors].filter((v) => !seenVids.has(v));

  return {
    metrics: {
      date,
      pv,
      uv: visitors.size,
      newVisitors: newVisitors.length,
      pairCount,
      tunnelConnections,
      activeHosts: hosts.size,
    },
    newVisitors,
  };
}
