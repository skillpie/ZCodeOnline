import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDailyReportCard, buildMessageBody, shanghaiTimeString } from "../src/dailyReport/feishuCard.js";
import { aggregateDaily } from "../src/dailyReport/metrics.js";
import { isoDayPrefix, nginxDayLabel, parseRelayLine, parseStatsLine } from "../src/dailyReport/parse.js";

// 运营日报口径验收（specs/web-daily-report.md §1/§5）：日志解析、去重/新访客、卡片结构与消息体组装。

// 固定「当天」做断言基准：日期部分与本地时区无关（parse/aggregate 都按本地日期前缀过滤）。
const NOW = new Date(2026, 8, 29, 23, 0, 0); // 2026-09-29 23:00 本地时间
const DAY_ISO = "2026-09-29";

const statsLine = (vid: string, ip = "203.0.113.5", iso = `${DAY_ISO}T10:00:00+08:00`) =>
  `${iso}\t${ip}\t${vid}\thttps://zcode.skillpie.cn/\tMozilla/5.0`;

const relayLine = (method: string, path: string, status: number, time = "29/Sep/2026:22:00:00 +0800") =>
  `203.0.113.5 - - [${time}] "${method} ${path} HTTP/1.1" ${status} 0 "-" Mozilla/5.0`;

test("parse：日期前缀与 combined 日期标签互为同一天的两种格式", () => {
  assert.equal(isoDayPrefix(NOW), DAY_ISO);
  assert.equal(nginxDayLabel(NOW), "29/Sep/2026");
});

test("parseStatsLine：TAB 分隔，UA 内含分隔符不影响前四段", () => {
  const visit = parseStatsLine(`${DAY_ISO}T09:00:00+08:00\t1.2.3.4\tvid-x\t\tTab\tUA\t1.0`, DAY_ISO);
  assert.ok(visit);
  assert.equal(visit.ip, "1.2.3.4");
  assert.equal(visit.visitorKey, "vid-x");
});

test("parseStatsLine：非当日与缺 IP 的行返回 null，缺 vid 按 IP 兜底", () => {
  assert.equal(parseStatsLine("2026-09-28T10:00:00+08:00\t1.2.3.4\tvid-x\t\tUA", DAY_ISO), null);
  assert.equal(parseStatsLine(`${DAY_ISO}T10:00:00+08:00\t\tvid-x\t\tUA`, DAY_ISO), null);
  const fallback = parseStatsLine(`${DAY_ISO}T10:00:00+08:00\t5.6.7.8\t\tUA`, DAY_ISO);
  assert.equal(fallback?.visitorKey, "ip:5.6.7.8");
});

test("parseRelayLine：提取方法/路径（去查询串）/状态", () => {
  const req = parseRelayLine(
    `203.0.113.5 - - [29/Sep/2026:22:00:00 +0800] "GET /ws/tunnel/host-1?token=abc HTTP/1.1" 101 0 "-" UA`,
  );
  assert.deepEqual(req, { method: "GET", path: "/ws/tunnel/host-1", status: 101 });
  assert.equal(parseRelayLine("garbage line"), null);
});

test("aggregate：PV/UV 按访客键去重，新访客对照 seen 集合", () => {
  const { metrics, newVisitors } = aggregateDaily({
    statsLines: [
      statsLine("vid-a"),
      statsLine("vid-a", "203.0.113.5", `${DAY_ISO}T11:00:00+08:00`),
      statsLine("vid-b", "203.0.113.6"),
      statsLine("vid-old", "203.0.113.7"),
    ],
    relayLines: [],
    seenVids: new Set(["vid-old"]),
    now: NOW,
  });
  assert.equal(metrics.pv, 4);
  assert.equal(metrics.uv, 3);
  assert.equal(metrics.newVisitors, 2);
  assert.deepEqual(newVisitors.sort(), ["vid-a", "vid-b"]);
});

test("aggregate：配对只计 2xx，隧道只计 101 且活跃宿主去重，非当日行不计", () => {
  const { metrics } = aggregateDaily({
    statsLines: [],
    relayLines: [
      relayLine("POST", "/api/v1/pair", 200),
      relayLine("POST", "/api/v1/pair", 401),
      relayLine("POST", "/api/v1/assist/connect", 200),
      relayLine("GET", "/ws/tunnel/host-1", 101),
      relayLine("GET", "/ws/tunnel/host-1", 101, "29/Sep/2026:22:30:00 +0800"),
      relayLine("GET", "/ws/tunnel/host-2", 101),
      relayLine("GET", "/ws/host", 101),
      relayLine("GET", "/ws/tunnel/host-3", 101, "28/Sep/2026:22:00:00 +0800"),
    ],
    seenVids: new Set(),
    now: NOW,
  });
  assert.equal(metrics.pairCount, 1);
  assert.equal(metrics.tunnelConnections, 3);
  assert.equal(metrics.activeHosts, 2);
});

test("卡片：标题 ZCodeOnline运营日报，双栏字段与页脚齐全", () => {
  const card = buildDailyReportCard(
    {
      date: DAY_ISO,
      pv: 128,
      uv: 23,
      newVisitors: 11,
      pairCount: 31,
      tunnelConnections: 27,
      activeHosts: 8,
    },
    NOW,
  );
  assert.equal(card.header.title.content, "📊 ZCodeOnline运营日报");
  assert.equal(card.header.template, "indigo");
  const fields = card.elements[0]!.fields as Array<{ text: { content: string } }>;
  assert.equal(fields.length, 6);
  assert.ok(fields.every((f) => f.text.tag === "lark_md"));
  assert.ok(fields.some((f) => f.text.content.includes("128")));
  const note = card.elements[2]!.elements as Array<{ content: string }>;
  assert.match(note[0]!.content, /^统计范围: 今日 0 点至 23 点 \| 生成于 /);
});

test("消息体：卡片序列化进 content，与 skillpie 的 im/v1/messages body 同构", () => {
  const card = buildDailyReportCard(
    {
      date: DAY_ISO,
      pv: 1,
      uv: 1,
      newVisitors: 1,
      pairCount: 0,
      tunnelConnections: 0,
      activeHosts: 0,
    },
    NOW,
  );
  const body = buildMessageBody("usr-42", card);
  assert.deepEqual(Object.keys(body).sort(), ["content", "msg_type", "receive_id"]);
  assert.equal(body.receive_id, "usr-42");
  assert.equal(body.msg_type, "interactive");
  assert.equal(JSON.parse(body.content).header.title.content, "📊 ZCodeOnline运营日报");
});

test("页脚时间固定按 Asia/Shanghai 输出（与服务器时区无关）", () => {
  // UTC 2026-09-29 16:30 = 上海 2026/9/30 00:30，日期应随上海时区走。
  const text = shanghaiTimeString(new Date("2026-09-29T16:30:00Z"));
  assert.equal(text, "2026/9/30 00:30:00");
});
