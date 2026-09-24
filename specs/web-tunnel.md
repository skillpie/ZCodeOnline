# Spec: Web 隧道（浏览器一等客户端）

> 目标：用户不装桌面 App 也能在浏览器获得 ZCode 会话能力（A 方案/隧道模式）。代码与文件全部留在用户本机，浏览器只是 UI；relay 只做鉴权、配对、心跳、转发。
> 已定决策：① 隧道宿主以 `zcode-server-cli` 为主（具备更新/服务化基座），桌面 App 为增强形态；② 权限请求在浏览器内直接确认（M3 生效，信任模型自 M1 起按此设计）；③ E2E 加密在 M1 落地，不留"先明文后补"的过渡期。
> 前提事实：v4 协议已有 `clientMode`（`desktop-continuous` / `web-remote-replayable`）双档投递与能力协商；会话权威状态（快照、重放缓冲）全在宿主/CLI 侧；`packages/web` 挂载全量 App；`relay_bridge` 投递类型目前有类型无实现（`packages/shared/src/task-realtime.ts:78`）。
> 实现状态（M1 数据面）：隧道契约与 E2E 加密（`packages/shared/src/tunnel.ts`、`tunnelCrypto.ts`）、relay 参考实现（`apps/zcode-relay`）、宿主出站连接器与配对逻辑（`packages/zcode-server-cli/src/tunnel/`）已完成并有测试；尚待接线：CLI `serve`/`pair` 命令集成、浏览器侧传输实现（`packages/ui/src/v4/transport.ts` 接缝，e2e-hello 由浏览器传输层发起）、桌面 App 复用连接器。

## 1. 产品规则

- 浏览器通过 relay 连回用户本机宿主，操作本地 workspace；**代码不上传云端，relay 不落任何业务内容**。
- 宿主形态优先级：`zcode-server-cli`（`serve` 常驻 + `pair` 配对）为主；桌面 App 在线时同样可被浏览器接入（复用同一出站连接器，后继接入）。
- 配对是显式动作：本机生成二维码/短码，浏览器扫码并完成账号登录后绑定；未配对设备不可见、不可连。
- M1 能力面 = `web-remote-replayable` 档（对话、订阅、发消息、附件读、快照恢复），与今日手机端等价；权限确认等桌面专属副作用在 M3 开放为浏览器内直接确认。
- 企业可配置"禁用 web 接入"开关（M4）：宿主侧一键拒绝所有隧道入站。
- 不做：云端工作区、代码云托管、relay 侧会话排队或离线缓存。

## 2. 总体架构与状态所有者

```text
浏览器（packages/web，全量 UI + replayable 档）
  │  WSS（传输 TLS 到 relay；业务帧由两端用 PSK 派生密钥端到端加密）
  ▼
relay 服务（独立部署；数据面 = 加密字节管道 + 路由表，控制面 = 配对/凭证/心跳）
  │  WSS（宿主出站长连接，管道内同样只见密文）
  ▼
本机宿主（zcode-server-cli）
  ├─ 隧道连接器（新组件：出站拨号 + 解密桥接到 loopback /ws）
  ├─ 现有 loopback HTTP/WS server（/ws、/ws/host 语义不变）
  └─ agent runtime + 本地 workspace（权威状态唯一所有者）
```

| 状态                    | 所有者                                  | 说明                                                          |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------- |
| 会话/任务/快照/重放缓冲 | 本机宿主（agent runtime + CLI gateway） | 现状不变，relay 与浏览器均无第二事实                          |
| 设备-账号绑定表         | relay（控制面）                         | relay 唯一持久状态，属鉴权范畴，非业务状态                    |
| 会话凭证                | relay 签发、宿主与浏览器持有            | 短期化 + 刷新 + 吊销（M2 完善）                               |
| 配对码                  | 宿主生成、relay 校验消费                | 一次性、短 TTL；内容 = relay 端点 + hostId + PSK + 配对 token |
| 路由表（hostId → 连接） | relay（数据面，内存态）                 | 宿主断线即失效，不持久化                                      |
| 宿主 PSK                | 宿主生成并持久化到本机数据目录（0600）  | 经配对二维码带外传递；HKDF 派生双向 AES-256-GCM 密钥          |
| 浏览器 UI 状态          | packages/ui store（投影）               | 现状不变                                                      |

- 依赖方向：`packages/web` 与 `zcode-server-cli` 只依赖 `packages/shared` 中的隧道契约类型；均不 import relay 实现细节。
- 隧道契约（握手帧、路由帧、错误码、配对 payload）定义在 `packages/shared`（新增 `tunnel.ts`）；relay 参考实现独立成部署单元（先 `apps/` 下新包，后继可拆仓库）。

## 3. M1：隧道数据面

### 3.1 relay 角色

- **数据面**：浏览器与宿主各自与 relay 建立一条 WSS；relay 按 `hostId` 把两条连接做字节级拼接（splice）。relay 不解析、不缓存、不压缩管道内容——TLS 在管道内端到端，relay 只见密文与路由元数据（hostId、连接数、字节数、心跳时间戳）。
- **控制面**（HTTPS）：设备注册与配对码校验、会话凭证签发/刷新/吊销、设备列表查询、心跳上报。AGENTS.md 对 relay 的职责定义（鉴权、配对、心跳、转发，不保存任务队列、快照等业务状态）即本设计的红线。
- 心跳：宿主出站连接周期 ping（间隔与超时进契约常量）；超时即从路由表摘除，不做续期排队。

### 3.2 宿主出站连接

- `zcode-server-cli` 新增隧道连接器：进程启动后**出站**拨号 relay（用户机器不开入站端口），拼接流内的业务字节端到端加密，连接器解密后按 WS 消息 1:1 转发给本机 loopback server 的现有 `/ws`。
- loopback server 的 fail-closed 原则不变（`packages/zcode-server-cli/src/server-core/http.ts:126-131`）：对外监听仍被禁止，隧道是唯一远程入口。
- 宿主首次 `serve` 时生成 PSK 并持久化到 `<serverRoot>/tunnel/state.json`（0600）；`pair` 时展示配对码（内容：relay 端点 + hostId + PSK + 一次性配对 token）。
- 断线重连：指数退避 + 随机抖动，重连后重新注册路由表与未过期配对 token；退避参数进契约常量（惊群削峰的精细化留 M4）。

### 3.3 配对时序

```text
宿主                    relay                     浏览器
 │ 1. serve 启动，出站注册 hostId ──▶│
 │ 2. pair：生成配对码（二维码+短码） │
 │    （relay 端点+hostId+PSK+        │
 │      一次性配对 token，TTL 短）    │
 │ 3. 配对 token 哈希预登记 ─────────▶│
 │                                  │◀── 4. 扫码/输码 + 账号登录（现有 ZAI OAuth）
 │                                  │ 5. 校验：token 一次性、TTL 内、账号有效
 │                                  │ 6. 绑定 (userAccount, hostId)；签发会话凭证
 │                                  │──▶ 7. 浏览器携凭证连 relay 数据面
 │ 8. relay 拼接浏览器连接到宿主隧道 ◀│
 │ 9. 两端交换 e2e-hello（首条密文，GCM 校验通过即证明 PSK 一致）
 │ 10. 现有 /ws replayable 握手照常（clientHello → snapshot → 增量）
```

- 配对码一次性消费，过期或重放一律失败（语义对齐现有一次性 host capability：`packages/server/src/hostCapability.ts` 的"先删除再判定"）。
- 解绑 = relay 删除 (user, hostId) 绑定并吊销凭证；宿主侧无需感知时序（下次连接自然被拒）。

### 3.4 加密边界

- **应用层端到端加密**。实现注记：最初设计的"宿主自签证书 + 浏览器校验指纹"不可行——浏览器无法在 `wss://` 上信任自签证书，且无 ACME/域名基建；改为传输 TLS 由 relay 终结、业务字节由两端用 PSK 派生密钥自加密，零知识 relay 的安全性质不变：
  - 密钥：`HKDF-SHA256(PSK, salt=hostId, info=方向)` 派生 client→host 与 host→client 两把独立 AES-256-GCM 密钥（方向分离杜绝 nonce 复用），实现在 `packages/shared/src/tunnelCrypto.ts`（WebCrypto，node/浏览器同构）；
  - 帧格式：`[8B BE 序号][密文]`，AAD 绑定方向；解密强制序号严格递增（允许跳号、禁止回落），重放与乱序一律拒绝；
  - 握手：拼接建立后双方第一条密文必须是 `e2e-hello`，GCM 校验通过即证明 PSK 一致，随后才放行业务帧；
  - relay 被攻破或被传票只能得到密文与元数据（最多 DoS）。
- PSK 经配对二维码带外传递，只存在于二维码与两端本地；relay 只见配对 token 哈希。
- relay 数据面禁明文：拼接管道内 hello 之后只允许二进制帧，text 帧视为契约破坏即断连。

### 3.5 事件顺序与失败语义

- **宿主离线**：路由表无此 hostId，relay 在控制面返回明确的"宿主不在线"错误码；浏览器 UI 呈现离线态并保留"重试"。M1 不做离线排队。
- **浏览器断线**：重连走现有 replayable 恢复链路（快照 + 重放，缓冲在宿主侧，`apps/zcode-cli/.../v4-gateway.ts`）；relay 只需把新连接重新拼接。
- **宿主隧道断线**：出站退避重连；期间浏览器连接由 relay 主动关闭并报"宿主不在线"。
- **多浏览器并发**：多个浏览器会话可同时接入同一宿主，彼此独立（现有 server 多 ws client 语义）；会话间一致性由宿主侧既有机制保证，relay 无仲裁逻辑。
- **配对失败**：token 过期/重放/账号不符均返回同一错误码，不区分原因（防枚举）。

## 4. M2：凭证与通道安全

- 会话凭证短期化：签发（access，分钟级）+ 刷新（refresh，天级）+ 吊销；接口在 M1 即按此形状定义（`issue/refresh/revoke`），M1 先实现 TTL + 吊销，M2 补刷新与设备列表 UI。
- relay 控制面真鉴权中间件（server-cli 今日 loopback fail-closed，隧道入口不能沿用共享静态 token 模式，`packages/server/src/http.ts:187` 的 `?token=` 方式不进入隧道链路）。
- 渲染层加固审计：模型输出与工具结果一律按不可信内容渲染（无 `dangerouslySetInnerHTML`）、严格 CSP、凭证不进 localStorage（现有 browserOAuthCredentialRepo 的 localStorage JWT 模式在隧道会话中替换为内存 + 刷新）。
- 权限请求浏览器内直接确认的信任前提在此期锁定：浏览器会话自 M2 起具备"审批权"，宿主侧必须留审批审计日志（谁、何时、批了什么命令）。

## 5. M3：升格一等客户端

- 为浏览器放宽 replayable 副作用门禁（`packages/services/src/zcode-agent_connectionScope` 的本地副作用拒答路径），权限请求走浏览器内 UI 直接确认；`nativeDialogs`/`localTerminal` 等桌面专属能力维持桌面独占，不造远程等价物。
- `packages/web` 的 `IPlatformService` 回填真实能力：文件选择、附件直传、更新器（更新语义 = 宿主侧 server-cli 更新，浏览器只呈现状态）。
- 能力探测式降级：strict capabilities 不匹配即握手失败的现状需补平滑层——老宿主 + 新浏览器时按能力集裁剪 UI，而非连接失败；新档位必须扩展"两档终态逐字节一致"的黄金不变量测试。

## 6. M4：规模化与运维

- relay 多地域数据面部署（配对/鉴权控制面可中心化）；重连惊群削峰（抖动退避参数化 + 分批放行）。
- server-cli 自动更新接线（release catalog/sha256/服务化基座已具备，`packages/zcode-server-cli/src/cli.ts`）；浏览器更新器语义 = 展示宿主版本与更新态。
- 企业开关：宿主配置"禁用 web 接入"后拒绝一切隧道入站，桌面本地能力不受影响。
- 带宽与成本监控：relay 侧按 hostId 维度统计字节数与连接时长（仅元数据）。

## 7. 验收场景

M1（数据面）：

1. 本机 `zcode-server-cli serve` 常驻，`pair` 展示二维码；外网浏览器扫码 + 账号登录后进入工作区，可见本地 workspace 会话列表、继续对话、上传读取附件（replayable 能力面）。
2. 浏览器刷新/断网重连，会话经快照恢复，无消息丢失（重放链路）。
3. 宿主进程停止 → 浏览器显示"宿主不在线"；重启后自动恢复接入。
4. 配对码过期、重放、错误账号 → 一律拒绝，错误码不区分原因。
5. 在 relay 节点抓包，管道内容为密文；控制面无任何会话/消息内容。
6. 回归：`desktop-continuous` 链路黄金测试通过，桌面本地使用行为与接入前无差异；`pnpm typecheck` / `pnpm lint` 通过。

M2：凭证过期自动刷新无感；吊销后已连浏览器即时断开；审批审计日志可查。
M3：浏览器内权限弹窗可直接确认并生效；老宿主 + 新浏览器按能力集降级不报错。
M4：企业开关打开后浏览器无法接入，桌面不受影响。

## 8. 与现有代码的接缝

| 现有资产                                                           | 位置                                                                                                                  | 用法                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| replayable/continuous 双档投递与能力协商                           | `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`、`packages/shared/src/zcode-protocol-v4/profiles.ts` | M1 直接沿用 replayable 档；M3 放宽门禁  |
| `/ws`（replayable）与 `/ws/host`（continuous + 一次性 capability） | `packages/zcode-server-cli/src/server-core/http.ts`                                                                   | 宿主侧入口不变，隧道代理到 loopback     |
| 一次性票据"先删后判"语义                                           | `packages/server/src/hostCapability.ts`                                                                               | 配对码消费语义对齐                      |
| 短码绑定模式（30s TTL）                                            | `packages/services/src/bots/botsService.ts`                                                                           | 配对码 TTL/展示形式参考                 |
| 快照 + 重放缓冲（宿主侧权威）                                      | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`                                               | 断线恢复不变                            |
| web 全量 UI + 传输注入接缝                                         | `packages/web/src/main.tsx`、`packages/ui/src/v4/transport.ts`                                                        | 换隧道传输实现                          |
| `relay_bridge` 类型槽位                                            | `packages/shared/src/task-realtime.ts:78`                                                                             | 隧道打通后接入实时投递（M3 后评估）     |
| server-cli 更新/服务化基座                                         | `packages/zcode-server-cli/src/cli.ts`、`runtime/releaseDownload.ts`                                                  | M4 自动更新接线                         |
| 隧道契约 + E2E 加密（M1 新增）                                     | `packages/shared/src/tunnel.ts`、`tunnelCrypto.ts`                                                                    | 帧 schema、配对编解码、密钥派生与加解密 |
| relay 参考实现（M1 新增）                                          | `apps/zcode-relay`                                                                                                    | 控制面 REST + 数据面拼接                |
| 宿主出站连接器（M1 新增）                                          | `packages/zcode-server-cli/src/tunnel/`                                                                               | 出站拨号/退避重连/加密桥/配对会话       |
