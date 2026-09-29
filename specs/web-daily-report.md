# Spec: ZCode Web 每日运营日报（nginx 日志统计 + 飞书推送）

> 实现入口：`packages/web/index.html`（匿名 PV beacon）、`apps/zcode-relay/deploy/zcode.skillpie.cn.conf`（`/stats.gif` 统计日志 + `/relay/` 独立访问日志）、`apps/zcode-relay/src/dailyReport/`（解析/聚合/飞书卡片/CLI，esbuild 单文件）、`apps/zcode-relay/deploy/zcode-daily-report.{service,timer}`（每日 23:00 触发）、`deploy_web.sh`（部署脚本与 timer）。
> 本 spec 只约束 Web 隧道部署（zcode.skillpie.cn）的运营统计与日报推送；桌面端无任何埋点，relay 进程本身保持无状态（不新增端点、不落盘）。发送实现与 skillpie 工程 `lib/feishu/client.ts` 的运营日报同构（tenant_access_token + im/v1/messages），卡片样式与其 `sendDailyReportNotification` 对齐。

## 1. 产品规则

- 日报每晚 **23:00（服务器本地时间）** 经**飞书应用 API**（`FEISHU_APP_ID`/`FEISHU_APP_SECRET` 换 tenant_access_token，`im/v1/messages?receive_id_type=user_id`）发送到 `FEISHU_NOTIFY_USER_ID`（默认 user_id，可覆盖为 chat_id 发群），统计范围为**当日 00:00 至发送时刻**。
- 卡片标题「📊 ZCodeOnline运营日报」（indigo 主题），字段（双栏）：PV、UV、新访客、配对次数、浏览器隧道连接数、活跃宿主数；页脚注明统计范围与生成时间（zh-CN / Asia/Shanghai，同 skillpie）。
- 指标口径：
  - **PV** = 当日 `/stats.gif` beacon 次数（每次页面加载一次）。
  - **UV** = 当日去重匿名访客 ID（`vid`，缺失时按 IP 兜底）。
  - **新访客** = 当日 vid 集合中历史未出现过的数量（历史记录持久化在服务器 `/var/lib/zcode-stats/seen-vids`）。
  - **配对次数** = 当日 `POST /api/v1/pair` 成功（2xx）次数。
  - **浏览器隧道连接数** = 当日 `GET /ws/tunnel/:hostId` 升级成功（101）次数。
  - **活跃宿主数** = 当日发生过浏览器隧道连接的去重 `hostId` 数。
- beacon 完全匿名：`vid` 为浏览器端随机 UUID，不携带账号、会话或业务内容；本地开发（localhost/127.0.0.1）不发 beacon。
- 飞书凭证未配置（缺 APP_ID/APP_SECRET/NOTIFY_USER_ID 任一）时，定时任务正常结束并记日志跳过发送；`--list-chats` 供部署者查应用所在群的 chat_id。

## 2. 状态所有者与数据流

```
浏览器 ── GET /stats.gif?vid=... ──▶ nginx（zcode_stats.log，唯一日志所有者）
宿主/浏览器隧道 ──▶ nginx（zcode_relay.log，/relay/ 独立访问日志）
                                      │
每日 23:00 systemd timer（zcode-daily-report）
                                      ▼
daily-report.js（一次性进程）：读两份日志 + seen-vids ──▶ 聚合 ──▶ 飞书开放平台 API
                                      └──▶ 追写 seen-vids（唯一持久状态所有者）
```

- 日志文件由 nginx 独占写，脚本只读；`seen-vids` 由脚本独占读写（每日一次，无并发）；relay 进程不参与统计。
- 时间基准统一为**服务器本地时间**：nginx `$time_iso8601`、timer `OnCalendar`、脚本按当日日期过滤三者一致；卡片页脚时间固定按 Asia/Shanghai 输出（同 skillpie）。
- 事件顺序：timer 触发 → 读日志快照 → 聚合 → 更新 seen-vids → 取 token → 发送。任一步失败不回写已生成的中间态；发送失败以非零码退出由 journald 记录，不重试（次日日报不受影响）。

## 3. 失败语义与幂等边界

- 日志文件缺失或当日无行：按 0 聚合并照常发送（全 0 卡片优于静默）。
- seen-vids 文件缺失：视为空历史，当日全部 vid 计为新访客，随后创建文件。
- 手动重跑同一天：配对/连接等日志计数不变；新访客会因 seen-vids 已入库而偏少——接受，文档注明不建议重跑。
- 日志轮转（logrotate）按 nginx 默认策略，23:00 读取的是当日活跃日志文件，脚本不处理轮转文件。

## 4. 迁移边界

- relay 纯内存边界不变；若未来需要会话级身份（配对 ID 关联 UV），迁移到 relay 内置统计 + 持久化属于架构变更，需另行评审，不在本 spec 范围。
- nginx conf、systemd unit、report.env（含飞书凭证）均经 `deploy_web.sh` 部署；`FEISHU_APP_ID`/`FEISHU_APP_SECRET`/`FEISHU_NOTIFY_USER_ID` 只存本机 `deploy.env` 与服务器 `/opt/zcode-relay/report.env`（0600），不入库、不进日志。

## 5. 验收场景

- 部署后浏览器（非 localhost）打开 `https://zcode.skillpie.cn/`：网络面板出现一次 `/stats.gif` 请求，`zcode_stats.log` 新增一行且 `vid` 与 localStorage `zcode-vid` 一致；刷新再增一行（PV+1、UV 不变）。
- 清除站点 localStorage 后刷新：同 IP 新 vid，当日「新访客 +1」。
- 宿主 `zcode tunnel-enable` + 浏览器配对进入应用：当日「配对次数 +1、浏览器隧道连接 +1、活跃宿主 +1」。
- 服务器 `systemctl start zcode-daily-report` 手动触发：飞书收到与聚合数据一致的「ZCodeOnline运营日报」双栏卡片；凭证未配置时 journald 出现 skip 日志且退出码为 0。
- 单元测试：日志行解析（stats/combined/101/hostId 提取）、聚合口径（去重/新访客/日期过滤）、卡片结构与消息体组装。
