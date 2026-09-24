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
- 不做：技能目录聚合进商店页、安装桥接、内页与 App 的深度集成（后续需要时再扩展）。
- **账号打通（ZCode → SkillPie 免登，自动注册）**：
  - 视图挂载后与 skillpie 页面握手，提供 ZCode 平台 JWT（`zcodejwttoken`）与展示资料（displayName）。
  - skillpie 服务端 `POST /api/sso/zcode` 在线验证 JWT（调 zcode 平台鉴权接口，2xx 放行；信任锚 = 平台签发方），按 `zcode:<sub>` 唯一绑定**自动注册**（生成 appKey/推广码/欢迎通知，对齐既有第三方注册行为）或直接登录，签发本站会话。
  - 会话 Cookie 在 https 下带 `SameSite=None; Secure; Partitioned`（CHIPS），使登录态能在 ZCode 的跨站 iframe 内存活（Chrome/Edge 系）；Safari 等不支持 CHIPS 的浏览器由 `Authorization: Bearer <sessionToken>` 兜底（guards 同时接受 CLI token / 会话 token / `sk_` appKey）。
  - 握手协议（双端字面量，以本 spec 为契约）：
    1. 子页 → 宿主：`{ type: "skillpie:sso-request" }`（iframe postMessage 到 parent；webview 由 preload 在加载时 `sendToHost` 主动发起）。
    2. 宿主 → 子页：`{ type: "zcode:sso-response", jwt: string | null, profile: { displayName?: string } }`（iframe 按 `targetOrigin = https://skillpie.cn` 严格回包；webview 走 `webview.send`，preload 转投 `window.postMessage`）。JWT 仅由真正持有它的 ZCode 宿主提供，恶意页面嵌入 skillpie 只能拿到空 JWT。
  - ZCode 侧 JWT 通路：Web 入口注入 `RootProps.loadZcodeSsoJwtToken`（浏览器 localStorage）；桌面端回落宿主凭据库 `credentialService.load("zcodejwttoken")`。都取不到时回空 JWT，页面降级为 skillpie 自身登录。
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
8. en-US 界面下入口与面包屑显示 "Skill Marketplace"。
