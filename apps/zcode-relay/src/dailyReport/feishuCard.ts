// 飞书运营日报卡片（specs/web-daily-report.md §1）：双栏 interactive 卡片。
// 卡片结构与样式对齐 skillpie 工程 lib/feishu/client.ts 的 sendDailyReportNotification：
// lark_md 字段 + indigo 主题 + 「统计范围 | 生成于」页脚（zh-CN / Asia/Shanghai 时间）。
import type { DailyMetrics } from "./metrics.js";

const field = (label: string, value: string) => ({
  is_short: true,
  text: { tag: "lark_md", content: `**${label}：**\n${value}` },
});

/** zh-CN + Asia/Shanghai 的时间文案，与 skillpie 日报页脚同格式（2026/9/28 23:00:00）。 */
export function shanghaiTimeString(at: Date): string {
  return at.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function buildDailyReportCard(metrics: DailyMetrics, generatedAt: Date) {
  return {
    header: {
      title: { tag: "plain_text", content: "📊 ZCodeOnline运营日报" },
      template: "indigo",
    },
    elements: [
      {
        tag: "div",
        fields: [
          field("PV", String(metrics.pv)),
          field("UV", String(metrics.uv)),
          field("新访客", String(metrics.newVisitors)),
          field("配对次数", String(metrics.pairCount)),
          field("浏览器隧道连接", String(metrics.tunnelConnections)),
          field("活跃宿主", String(metrics.activeHosts)),
        ],
      },
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `统计范围: 今日 0 点至 23 点 | 生成于 ${shanghaiTimeString(generatedAt)}`,
          },
        ],
      },
    ],
  };
}

/**
 * 组装 im/v1/messages 的请求体：卡片对象需 JSON 序列化进 content 字段；
 * receive_id_type 是 URL 查询参数（skillpie 用 user_id；发群用 chat_id），不进 body。
 */
export function buildMessageBody(
  receiveId: string,
  card: unknown,
): { receive_id: string; msg_type: "interactive"; content: string } {
  return { receive_id: receiveId, msg_type: "interactive", content: JSON.stringify(card) };
}
