# Spec: 技能市场入口（Skill Marketplace）

内置访问 SkillPie 技能市场的入口。本功能为**附加式**新增：一个侧边栏入口 + 一个工作区主区内嵌视图，不改插件商店与设置页既有逻辑。

## 1. 产品规则

- 工作区侧边栏「插件市场」按钮正下方新增「技能市场」入口，样式与相邻入口一致（ghost、`size="lg"`、图标 + 文案、`aria-pressed` 激活态）。
- 点击后以内置方式访问 `https://skillpie.cn/`，**不跳出应用**：
  - 视图是工作区主视图（`workspaceMainView === "skill-market"`），与 automations / plugin-store 同级；**侧边栏保持可见**，非全屏 overlay。
  - 主视图仅保留与 plugin-store 相同的桌面面包屑拖拽区（`AutomationsMainBreadcrumbFrame`）；**没有关闭、前进、后退按钮**，离开视图靠侧边栏切换到其他入口/会话。
  - 桌面端（Electron）：`<webview>`，独立持久分区 `persist:zcode-skill-market` 保留 skillpie.cn 登录态；主 frame 加载失败显示错误态（重试 / `openExternal` 兜底）。
  - Web 端（浏览器）：`<iframe>`（skillpie.cn 未下发 `X-Frame-Options`/CSP `frame-ancestors`，可直接嵌入）；跨源拿不到子页导航态与失败信号，不做错误兜底 UI。
- 站内 `target=_blank` 外链复用主进程既有路由（非 Coding Plan guest → 内置 Browser tab），本功能不在主进程新增逻辑。
- 不做：技能目录聚合进插件商店页、内嵌网页面与 App 的深度集成（后续需要时再扩展）。聊天面板市场搜索与原生安装见 §5，属于本期范围。
- **账号打通（ZCode → SkillPie 免登，自动注册）**：
  - 视图挂载后与 skillpie 页面握手，提供 ZCode 平台 JWT（`zcodejwttoken`）与展示资料（displayName）。
  - skillpie 服务端 `POST /api/sso/zcode` 在线验证 JWT（调 zcode 平台鉴权接口，2xx 放行；信任锚 = 平台签发方），按 `zcode:<sub>` 唯一绑定**自动注册**（生成 appKey/推广码/欢迎通知，对齐既有第三方注册行为）或直接登录，签发本站会话。
  - 会话 Cookie 在 https 下带 `SameSite=None; Secure; Partitioned`（CHIPS），使登录态能在 ZCode 的跨站 iframe 内存活（Chrome/Edge 系）；Safari 等不支持 CHIPS 的浏览器由 `Authorization: Bearer <sessionToken>` 兜底（guards 同时接受 CLI token / 会话 token / `sk_` appKey）。
  - 握手协议（双端字面量，以本 spec 为契约）：
    1. 子页 → 宿主：`{ type: "skillpie:sso-request" }`（iframe postMessage 到 parent；webview 由 preload 在加载时 `sendToHost` 主动发起）。
    2. 宿主 → 子页：`{ type: "zcode:sso-response", jwt: string | null, profile: { displayName?: string } }`（iframe 按 `targetOrigin = https://skillpie.cn` 严格回包；webview 走 `webview.send`，preload 转投 `window.postMessage`）。JWT 仅由真正持有它的 ZCode 宿主提供，恶意页面嵌入 skillpie 只能拿到空 JWT。
  - ZCode 侧 JWT 通路（与 UI 登录态同源）：统一先读 `credentialService.load("zcodejwttoken")`——Web 模式登录态/凭据都在 server 端（经 WebSocket RPC），桌面是宿主本地凭据库；再回落 `RootProps.loadZcodeSsoJwtToken`（浏览器 localStorage，仅 share/remote 等浏览器本地登录场景）。都取不到时回空 JWT，页面降级为 skillpie 自身登录。
  - 桌面 webview 需要专用 preload（`skillMarketWebview`），注入判断在主进程 `will-attach-webview`，origin 可用 `SKILL_MARKET_ORIGIN` 环境变量覆盖（测试部署）。
  - 旧 auth-center OAuth（`/api/oauth/*`、`lib/oauth/*`）已移除；skillpie 登录页保留账号密码与 CLI `login_code` 流（与 auth-center 无关）。

## 2. 状态所有者

```text
App（workspaceMainView: "chat" | "automations" | "plugin-store" | "skill-market"，唯一所有者）
  └─ WorkspaceShellLayout 按 view 分支渲染主区；skill-market 分支挂 SkillMarketEmbeddedView
       ├─ 桌面：<webview>（persist:zcode-skill-market 分区）＋ loadError ＋ IPC 握手
       └─ Web：<iframe> ＋ postMessage 握手（无跨源导航态）
            └─ skillpie 端：ZcodeSsoBridge → POST /api/sso/zcode → 会话 Cookie/Bearer
```

- 入口不携带参数、不持久化（重开应用回到 chat 视图）；切换到其他主视图即卸载内嵌元素，分区/cookie 保留。
- URL 常量 `SKILL_MARKET_URL` 私有于 `SkillMarketEmbeddedView.tsx`。
- 与 automations 同语义：不进 `useWorkspaceTaskNavigation` 历史、不调用 `preserveNextSettingsExit`（设置层退出统一回 chat 的既有规则天然覆盖）。

## 3. 事件顺序

- 打开：sidebar 点击 → `onOpenSkillMarket` → `setWorkspaceMainView("skill-market")` → 主区卸载 chat/其他视图、挂载内嵌元素。
- webview 生命周期：`did-start-loading` 清 loadError → `did-fail-load`（仅主 frame）置 loadError → `render-process-gone` 置 loadError；无导航态同步（无前进/后退 UI）。
- iframe 生命周期：挂载即加载，无本地状态。
- 离开：点击侧边栏任一会话/自动化/插件市场入口 → `workspaceMainView` 切换 → 内嵌元素卸载，持久分区保留。

## 4. 验收场景

1. 侧边栏「插件市场」下方出现「技能市场」；点击后主区加载 skillpie.cn，**侧边栏保持可见**，无全屏遮罩。
2. 视图顶部无关闭/前进/后退按钮；桌面端仅保留面包屑标签「技能市场」；入口按钮呈激活态（`bg-selected`）。
3. 点击侧边栏任意会话或「插件市场」「自动化」→ 平滑切回对应视图；再次进入技能市场时 skillpie.cn 登录态保留（桌面持久分区）。
4. skillpie.cn 站内 `target=_blank` 外链路由到应用内置 Browser tab（桌面），不产生脱离主窗口的新窗口。
5. 桌面断网打开 → 错误态；「重试」可恢复；「打开浏览器访问」走系统浏览器。
6. Web 端（5173/3030）点击「技能市场」→ 主区 iframe 呈现 skillpie.cn，不跳出新标签。
7. ZCode 已登录用户首次进入 → 自动在 skillpie 注册并登录（免手动输入）；未登录 ZCode → skillpie 正常展示自身登录入口。
8. 站内「安装/分享」点击复制安装文案：iframe 需宿主 `allow="clipboard-write"` 委托；桌面 webview 对 `clipboard-sanitize-write` 等权限请求予以批准。
9. en-US 界面下入口与面包屑显示 "Skill Marketplace"。

## 5. 聊天面板市场搜索与原生详情安装（SkillPie）

聊天 `/` 命令面板与 `$` 技能面板新增「技能市场」分组：搜索 SkillPie 公开目录，选中弹出 ZCode 原生样式的技能详情弹窗，弹窗内可直接安装到本地用户级技能目录。

### 5.1 产品规则

- 分组与触发：
  - `/` 面板分区顺序固定为 命令 → 本地技能 → 子智能体 → 技能市场；`$` 面板为 本地技能 → 技能市场。
  - 仅当存在非空查询（trim 后 ≥1 字符）时发起市场搜索与展示该分组；无查询时分组整体不出现。
  - 输入去抖 250ms；每次最多 6 条；搜索失败在分组内展示错误文案，不打断本地候选。
- 选中行为（`/` 与 `$` 一致）：移除输入中的触发 token（不插入任何 mention）、关闭面板、打开原生详情弹窗。
- 原生详情弹窗（ZCode 样式，非内嵌网页）：
  - 数据来自 SkillPie 详情接口 `GET {base}/api/skills/by-normalized-name/<normalizedName>`（公开免鉴权），展示名称、分类、作者、下载/点赞/版本/包大小与 `usageInstructions` markdown 文档；`screenshots` 存在时展示。
  - 免费技能（`isFree`）提供「安装」：下载 `version.packageDownloadUrl`（回退 download-url 接口）的 zip，校验 SKILL.md 后装入 `~/.zcode/skills/<normalizedName>`；同名已存在时提示已安装（不覆盖）。
  - 弹窗正文首屏必须醒目展示触发方式：显式引用 token（`$<normalizedName>`）+ 技能作者按约定写在描述末尾的触发词段（`触发词：…`，解析为徽标并从正文描述中移除；解析不出则完整展示描述）。
  - 付费技能（`isFree: false`）不提供程序化安装，按钮禁用并引导「前往技能市场」：打开既有内嵌市场视图并深链到该技能详情页（skillpie 站内既有链接格式 `/skills?skill=<normalizedName>`）；侧边栏入口不带参数（市场首页）。
  - 安装目标为当前 workspace 所属环境的用户级技能目录（本地 workspace = 本机 `~/.zcode/skills`；远程 workspace = 远端主机用户技能根，与 skills/skillSync 目录语义一致）；安装后不主动刷新已打开面板——`/`、`$` 面板每次打开都会重新拉取 catalog，自然纳新。
- 外部契约以 skillpie CLI 源码与线上实测为准；`baseUrl` 默认 `DEFAULT_SKILL_MARKET_URL`，可用 `ZCODE_SKILL_MARKET_URL`（node 侧）/ `VITE_SKILL_MARKET_URL`（UI 侧）覆盖用于联调。

### 5.2 状态所有者

```text
skillMarketStore（detailSkill: { normalizedName } | null，唯一所有者）
  ├─ SlashCommandPlugin / MentionPlugin：选中市场项 → openDetail(normalizedName)
  ├─ App 宿主：按 detailSkill 挂载 SkillMarketDetailDialog
  │     └─ 弹窗内安装 → ISkillMarketService.installSkill → ~/.zcode/skills
  └─ 关闭/安装完成 → closeDetail()
```

- 市场"已安装"事实的唯一来源是本地技能目录扫描（既有 skillsService/skillSync 语义），弹窗不维护第二份安装状态缓存。
- 搜索结果不跨 query 缓存；每个 debounce 周期一次请求，过期响应按请求序号丢弃。

### 5.3 事件顺序

- 搜索：query 变化 → 250ms 去抖 → `searchSkills` → 序号比对 → 分组渲染；面板关闭即置 `enabled=false` 并丢弃在途结果。
- 选中：面板选中 → 移除 token → `openDetail` → 面板关闭 → 弹窗挂载 → `getSkillDetail` → 渲染。
- 安装：点击安装 → `installSkill`（详情 → 下载 zip → 临时目录解压校验 → 复制到用户技能根）→ `installed | already-installed | failed` → 弹窗内反馈。

### 5.4 验收场景

1. `/` 输入 `redis` → 面板底部出现「技能市场」分组，约去抖后展示 6 条内结果；`$` 输入同样出现于本地技能分组之后。
2. 清空查询 → 市场分组消失；搜索接口断网 → 分组内展示错误文案，本地候选不受影响。
3. 键盘 ↓ 可达市场项，回车/点击 → 输入中 `/redis` token 被移除、面板关闭、弹出原生详情弹窗。
4. 详情弹窗展示文档与统计；点「安装」→ 成功提示；再次安装同技能 → 提示已安装且目录不重复。
5. 安装成功后重新打开 `$` 面板 → 该技能出现在本地技能分组、可引用。
6. 付费技能详情 → 安装禁用，「前往技能市场」切到内嵌市场视图。
7. en-US 界面下分组标题为 "Skill Marketplace"，弹窗文案同语言。
