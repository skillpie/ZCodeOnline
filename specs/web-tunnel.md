# Spec: Web 隧道（浏览器一等客户端）

> 目标：用户不装桌面 App 也能在浏览器获得 ZCode 会话能力（A 方案/隧道模式）。代码与文件全部留在用户本机，浏览器只是 UI；relay 只做鉴权、配对、心跳、转发。
> 已定决策：① 隧道宿主以 `zcode-server-cli` 为主（具备更新/服务化基座），桌面 App 为增强形态；② 权限请求在浏览器内直接确认（M3 生效，信任模型自 M1 起按此设计）；③ E2E 加密在 M1 落地，不留"先明文后补"的过渡期。
> 前提事实：v4 协议已有 `clientMode`（`desktop-continuous` / `web-remote-replayable`）双档投递与能力协商；会话权威状态（快照、重放缓冲）全在宿主/CLI 侧；`packages/web` 挂载全量 App；`relay_bridge` 投递类型目前有类型无实现（`packages/shared/src/task-realtime.ts:78`）。
> 实现注记（联调踩坑，后续传输层改动必读）：① WS 数据帧与 open 事件可能同块到达，事件监听晚于 await 续体就是永久丢帧——浏览器侧接收用单一阶段状态机（connected → hostHello → bootstrap → open），宿主侧监听挂载在拨号时而非 open 后，loopback 早期帧（ChannelServer 的 Initialize）经缓冲按序 flush；② `WebSocket.OPEN` 是静态属性、实例上不存在，`ws.readyState === ws.OPEN` 恒 false 会静默丢弃全部请求帧（白屏根因），用常量比较；③ 隧道只承载 WS RPC，server-info 由宿主连接器经 bootstrap 帧下发（浏览器端到端加密后首个业务帧），驱动 workspace 注入；④ transport 的 onData 实现订阅即重放（pendingIn），防止 ChannelClient 订阅前的 Initialize 丢失；⑤ 加密异步完成顺序不定，浏览器写/读与宿主出/入四条帧路径都必须按调用序串行化（writeChain/readChain/outboundChain/inboundChain），乱序帧会被对端序号守卫拒绝或打乱字节流（症状：单请求探针正常、高并发页面如任务列表全挂）；⑥ 运维守则：同一 hostId 只允许一个隧道进程——重复进程会触发 relay 顶替（Superseded）无限互踢，宿主反复重连、浏览器任务列表永远加载。
> 实现状态（M1 数据面 + 浏览器通道）：隧道契约与 E2E 加密（`packages/shared/src/tunnel.ts`、`tunnelCrypto.ts`）、relay 参考实现（`apps/zcode-relay`）、宿主出站连接器与配对逻辑（`packages/zcode-server-cli/src/tunnel/`）、前台 `tunnel` 子命令（联调入口，daemon 集成待做）、浏览器侧传输与配对门禁（`packages/web/src/tunnel/`，`?tunnel=1` 进入，e2e-hello 由浏览器传输层发起）均已完成并有测试。尚待接线：`serve` 守护进程内置隧道（需扩展 daemon 控制协议，spec 级改动）、桌面 App 复用连接器、扫码 UI（相机）与凭证存储 M2 强化。

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
- **daemon 集成**：隧道运行时归 Core 进程所有（与 loopback server 同进程，拼接流直连本机 `/ws`）。配置 `tunnel/config.json`（enabled + relayUrl）与身份 `tunnel/state.json` 分离——前者是用户意图，后者是身份秘密；Core 是两者唯一写入者，Supervisor 只做控制转发，CLI 不直接写文件（避免双写路径）。
- **控制协议扩展**（加法演进，`SERVER_CLI_PROTOCOL_VERSION` 保持 1）：`controlRequestSchema` 新增 `tunnel-status` / `tunnel-enable{relayUrl}` / `tunnel-disable` / `tunnel-pair`；Supervisor 校验后经 IPC `tunnel-control`（requestId 关联 + 10s 超时）转发给 Core，应答走 `tunnel-control-result`。旧 CLI 不发新命令；新 CLI 对旧 daemon 收到结构化错误。
- **CLI 命令**：`zcode tunnel-status` / `tunnel-enable --relay-url ...` / `tunnel-disable` / `tunnel-pair`（打印配对链接，TTL 内有效）；前台 `zcode tunnel --relay-url ...` 保留为联调入口，与 serve daemon 互斥使用（同一 hostId 双连接会被 relay 顶替互踢）。

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
- **relay 重启自愈**：relay 注册表驻内存，重启后宿主持久化凭证必然失效。宿主连接器收到 `invalidHostCredential` 时清掉本地凭证、以空凭证重注册并持久化新凭证（每次成功 hostReady 前最多自愈一次）；relay 侧 fail-closed——空凭证仅可注册未知 hostId，防止抢注顶替真实宿主。残余风险：攻击者若在 relay 重启窗口内已知 hostId 可抢注（仅 DoS，E2E PSK 不受影响）；浏览器侧绑定随重启清空，需重新配对。
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

## 5.5 桌面复用（增强形态，设计待评审）

桌面接入隧道有两条路线，实现前需与用户对齐取舍：

- **路线 A（正解，工作量在 Host）**：桌面窗口 Host 本就支持多 attachment（Renderer 与手机 attachment 共存，clientMode 感知，`packages/desktop/src/host/index.ts`）。在此之上新增一种"隧道 attachment"：TunnelConnector 的解密流经 WS→MessagePort 语义 shim，按 replayable attachment 准入窗口 Host（与手机同权限面）。优点：浏览器会话与桌面会话共享同一 Host、同一任务历史，无双所有者问题；权限弹窗可复用 Host 现有本地副作用门禁（M3 的浏览器内确认在此路径上自然落点）。代价：attachment 准入与 `hostMessagePortGuard` 需要适配非 MessagePort 传输，涉及 host 生命周期与 scope generation 语义，需单独 spec 评审。
- **路线 B（过渡）**：桌面 App 仅作为 server-cli daemon 的管理面（安装、`tunnel-enable`、展示配对码），浏览器流量进 server-cli 宿主。优点：零 Host 改动，全部复用 M1 已有能力；代价：同一 workspace 若同时被桌面窗口与隧道宿主打开，任务状态分属两个 runtime——依赖既有 owner/lease 与 stale-run 防护兜底，产品上需要明确"浏览器创建的任务在 server-cli 宿主"的语义。
- **建议**：路线 B 先行验证需求，路线 A 作为 M3+ 的正式形态单独立 spec。
- **实现与回退（2026-09）**：路线 B 已按"桌面 App 仅作 daemon 管理面"落地（`packages/desktop/src/main/desktopTunnelControl.ts` IPC 转发 + `packages/zcode-server-cli/src/tunnel/` daemon 控制 socket）。**2026-09-26 起按产品决策移除桌面管理面 UI 入口**：侧栏底部的「浏览器远程访问」触发按钮（`WorkspaceTunnelAccessTrigger`）与 `TunnelAccessDialog` 弹窗已删除，`tunnelManager.*` 文案同步清理；桌面→daemon 的 IPC 管理通道保留（无 UI 入口，供后续路线 A / 其他入口复用）。浏览器侧隧道入口（`?tunnel=1`、`/16位码`）不受影响。

## 5.7 产品化收尾（"陌生人三分钟装完"）

目标：新用户在本机只安装**一个自包含发行目录**即可在浏览器写代码；浏览器侧零安装。

- **发行物**：`pnpm --filter @zcode/server-cli stage` 产出 `<release>/bin/zcode`（launcher）+ `runtime/`（自包含 node 22、server-cli.js、zcode.cjs、原生工具、依赖闭包）——单目录、免全局安装、免预装 Node。
- **工作区指向**：Core 的 server-info 按 `ZCODE_SERVER_WORKSPACE` 环境变量或进程 cwd 解析初始工作区（对齐 `packages/server` 语义），浏览器 bootstrap 帧据此注入。多工作区注册留后续。
- **默认入口 + 默认开启**：`DEFAULT_TUNNEL_RELAY_URL`（wss://zcode.skillpie.cn/relay）为缺省 relay（`ZCODE_RELAY_URL`/`--relay-url` 可覆盖），业务端口缺省 3030。**隧道出厂默认开启**：从未配置的机器 `zcode serve` 起来即自动连产品 relay（配对码是唯一门禁，未配对无人可连）；`tunnel-disable` 持久化 enabled=false 并跨重启尊重。
- **serve 即完成一切**：serve 启动打印 `Remote access: https://zcode.skillpie.cn/<码>`（机器码从 state.json 读取，初始化时主动生成）——用户命令收敛为 `zcode serve`（前台联调 `zcode tunnel`）；模型登录可选——浏览器左下角登录入口即可（凭据落在宿主侧，agent 直接可用），headless 预配置才需要 `zcode login`。
- **流级 keepalive**：空闲期 nginx send/read 定时器与中间设备会静默切断流 TCP（relay 观测 1006）——连接器对流 20s 协议层 ping，relay 对拼接流两端互 ping。
- **登录**：`zcode login` 经 legacy 委托（`delegateLegacyCli`）复用 agent CLI 已有的 OAuth 授权-轮询登录（`loginZCodeCli`：打印授权 URL + 浏览器确认 + 轮换取 token），凭据写入 `~/.zcode/v2/credentials.json`（加密 KV），agent 与业务服务器共用。发行版缺 `zcode.cjs` 时给出明确指引（完整发行包或 `ZCODE_LEGACY_CLI_ENTRY`）。
- **安装脚本**：`deploy/install-zcode-server.sh` —— 平台自动探测（darwin/linux × arm64/x64）+ 从本站 `/dl/` 下载对应归档（标准形态 `curl -fsSL https://zcode.skillpie.cn/install.sh | sh`，已上线），支持 `--archive` 离线归档、`--install-dir`、`--workspace`、`--start`；解压到安装目录、symlink `bin/zcode` 进 PATH、systemd drop-in 注入工作区环境。**Windows 一键脚本**：`install-zcode-server.ps1` / `install.cmd`（形态 `irm https://zcode.skillpie.cn/install.ps1 | iex`、`curl -fsSL https://zcode.skillpie.cn/install.cmd -o install.cmd && install.cmd`），参数与 sh 版对齐，nginx 同名路由直出。归档发布：`deploy-zcode.sh --release`（stage 多平台构建 → `/var/www/zcode-dl/`，install.sh/ps1/cmd 一并发布）；**发行归档统一 tar.gz**（win32 不再特例 zip——install.ps1 与 deploy 脚本均按 `<releaseName>.tar.gz` 消费，Windows 10+ 内置 bsdtar 可直接解压；组件级归档仍按 target 差异化，不在本链路）。
- **Agent 代装指引**：公开入口 `GET https://zcode.skillpie.cn/agent/install`（nginx 别名 → relay 内部路由 `/api/install/agent`，`text/plain`）——给任意智能体（ZCode/Claude/Codex…）抓取的分步安装指引，内容与 deploy 脚本保持同步；对外一律用 `/agent/install`（`/api/*` 不作为用户/智能体可见 URL），门禁卡露出该 URL 作为"发给 AI 助手代装"入口。
- **登录回跳（自建域）**：浏览器 OAuth 的 redirect_uri 固定注册在官方域（`zcode.z.ai/cn/share/callback`），回调页因此运行在**官方构建**上。`app_return_to` 跳回按序放行：①同源（现状语义，仅 `/share|/cn/share` 路径，返回站内路径）；②构建期受信 origin（`VITE_TRUSTED_RETURN_ORIGINS`，逗号分隔，仅 http/https、不带凭据，返回**完整 URL** 跨域跳回）；③其余一律拒绝（防开放重定向）。白名单必须在**回调页所在部署**注入才生效——自建域构建注入自身 origin 只覆盖回调落在本域的未来形态（OAuth client 注册本域回调，二期）。无任何可回跳目标时回调页渲染"授权完成，请回到原页签"完成态，不再默默落回本站首页。宿主侧模型登录不受此影响：CLI/desktop 均为 pollToken 轮询拿凭据，回调页仅是用户提示页；隧道会话侧栏登录即宿主代登（`useOAuth` → RPC `startOAuthWithPolling`）。
- **门禁安装引导按平台分流**：连接引导卡（`TunnelGateScreen`）按 `navigator.userAgent` 判定 Windows——Windows 展示 PowerShell（推荐）与 CMD 两条一键命令，其余平台（含 UA 未知）沿用 `curl … install.sh | sh`；平台→命令的映射收敛在纯模块 `tunnelInstall.ts`，组件只做展示。不做浏览器内平台探测之外的设备形态推断（手机上的命令本就不服务于当前设备，回退既有文案）。
- **不做**：多工作区 UI、官方下载 CDN（先用自有服务器托管归档）。

## 5.8 本地配对发现（打开网站自动配对）

用户提案"浏览器自动读本地配对码"的落地形态：浏览器沙箱读不了本地文件，等效实现是**本地回环发现端点**（VS Code 隧道 / Spotify 桌面登录同款模式）。

- **端点**：宿主在 `127.0.0.1:4950`（`TUNNEL_DISCOVERY_PORT`）提供 `GET /tunnel/pairing`，每次调用生成**新鲜**的一次性配对会话（无 TTL 焦虑）；`OPTIONS` 处理 PNA preflight（`Access-Control-Allow-Private-Network: true`）。daemon（serve）与前台（`zcode tunnel`）均挂载；端口被占非致命（回退手动粘贴）。
- **浏览器侧**：门禁屏无已存会话时自动探测（`discoverLocalPairing`，1.5s 超时快速失败）→ 拿到配对链接 → 自动配对 → 连接。手机场景（不在宿主机上）探测必然失败，回退扫码/手动粘贴——设计使然。
- **安全边界**：仅回环绑定（局域网不可达）；CORS 白名单（`TUNNEL_DISCOVERY_ALLOWED_ORIGINS`：生产 origin + 本地 dev origin）+ PNA 头；恶意站点即使绕过 CORS 也无法配对（relay `/api/v1/pair` 需要账号 token 或一次性配对码）。relay REST 端点同样带 origin 白名单 CORS（dev 跨源场景）。
- **浏览器兼容注记**：Chrome 的 Local Network Access 权限——公网页面访问 localhost 会弹**一次**授权提示（拒绝则回退手动粘贴，刷新可重试）；Firefox/Safari 无提示直接可用；无头浏览器默认拒绝（自动化测试用本地 dev origin 验证，本地→本地不触发 LNA）。

## 5.9 远程协助（跨用户，A 的机器由 B 控制）

与自机隧道（同账号配对）不同的授权模型：**16 位远程码 = 一次性能力凭证**。

- **生成（A 侧）**：侧栏「远程」弹窗展示 A 的远程码（16 位数字，展示为 4-4-4-4 分组），由宿主生成并经控制通道 `assistRegister {assistCodeHash, maskedPsk, expiresAt}` 预登记到 relay（hostReady 后自动补登记，语义同配对 token）。「刷新」= 作废旧码换新码（同 hostId 仅一份有效邀请）。TTL 24h。
- **零知识 PSK**：relay 只存 `maskedPsk = psk ⊕ SHA-256(归一化码)` 与 codeHash——relay 无法还原 psk（缺码原像），会话仍端到端加密。B 兑换时用码还原。
- **机器码 = 持久公开地址**：码持久化在宿主 state.json（重启不换码）并随 hostReady 在 relay 重新登记（relay 重启也不失效）——`https://zcode.skillpie.cn/<16位码>` 是这台机器的稳定地址，收藏即可反复使用；多个浏览器可同时连接。
- **兑换（B 侧）**：打开 `https://zcode.skillpie.cn/<码>`（`/remote/<码>` 为别名）→ `POST /api/v1/assist/connect {code}` → relay 校验（哈希命中 + 有效，**校验不消费**）+ 按来源 IP 滑窗限流 → 返回 `{hostId, connectToken, maskedPsk}` → B 端还原 psk → 走既有隧道数据面连接宿主（bootstrap/E2E/应用渲染全复用）。
- **轮换与失效**：「刷新」= 换新码并作废旧链接；宿主 `tunnel-disable`/停跑 = 地址下线。断开后 B 端一键重连（码仍有效）。
- **码不进地址栏（浏览器侧存储）**：打开 `/<码>` 链接时把码写入 localStorage（`zcode-assist-code`，**后到优先**——多次使用不同链接以最后一次传入的码为准）后立即 `location.replace` 回干净域名首页，地址栏/投屏/历史记录不再暴露长期凭证；首页由 TunnelAppRoot 用存储码走同一兑换链路直连。
- **存储码失效不锁死**：存储码兑换返回 401（已在别处刷新/解绑）时清掉存储并回退既有连接链（已存配对会话 → 本地发现 → 门禁），门禁提示打开最新链接；多个浏览器各自打开新链接即可恢复，宿主不被任何旧浏览器锁死。
- **入口弹窗（Web 版）**：侧栏设置按钮左侧「我的远程码」图标按钮（仅实现 `IPlatformService.getRemoteAssistCode`/`refreshRemoteAssistCode` 的平台渲染，即浏览器与宿主同机的 Web 端）→ 弹窗先展示当前带码完整链接（宿主回环发现端点 `GET 127.0.0.1:4950/tunnel/assist` 为权威，不可达时回退本地存储码；`4-4-4-4` 分组 + 完整链接）并附「复制」「刷新」；「刷新」二次确认（明示旧链接立即失效）→ `POST /tunnel/assist/refresh` → 原地更新为新码/新链接（回写 localStorage），宿主不在本机时给出可读错误。桌面端轮换走 daemon 控制链路，契约暂未暴露。
- **UI**：侧栏设置按钮左侧「远程」按钮 → 弹窗两块：①我的远程码（展示/刷新/复制完整链接）；②输入对方远程码（复制 /remote/<码> 链接、新标签打开）。
- **信任模型注记**：B 匿名可连（码即凭证）；relay 参与会话建立但拿不到会话密钥；暴力枚举由 10^16 熵 + 每 IP 滑窗限流抵御。后续升级：ECDH 替代掩码、会话审计日志。
- **远程/隧道会话跳过账号引导**：Root 新增 `suppressAccountOnboarding`（禁用 provider 登录门禁）与 `suppressJwtInvalidReload`（禁用 JWT 失效整页 reload）——远程会话的模型凭据在被控机器上，浏览器侧登录状态与引导门对远程控制无意义（联调实证：无账号的浏览器会话被 WelcomeScreen 拦截 + JWT 广播触发整页 reload 循环）。普通 web 模式行为不变。

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
