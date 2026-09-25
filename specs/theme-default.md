# Spec: 应用主题默认值

> 实现入口：`packages/ui/src/useTheme.ts`（主题 hook）、`packages/ui/src/store/index.ts`（store 默认值）、`packages/web/index.html` 与 `packages/web/src/webThemeSeed.ts`、`packages/web/src/main.tsx`（Web 首屏防闪屏）、`packages/desktop/src/renderer/src/main.tsx` 与 `packages/desktop/src/renderer/src/resource-manager.tsx`（桌面首屏防闪屏）。
> 本 spec 只约束「用户从未选择主题时」的默认值；用户显式选择后的持久化（`zcode-theme` localStorage）与广播同步不在范围内。

## 1. 产品规则

- 新用户（`zcode-theme` 无存储值）默认主题为 **跟随系统**（`system`）：按 `prefers-color-scheme` 解析为 zai-light / zai-dark。
- 用户在设置页或头像菜单显式选择主题后，持久化到 `zcode-theme`，此后一切入口尊重存储值；默认值只在存储缺失时生效。
- 分享落地页（`isConversationSharePath`）维持自己的浅色默认（`zai-light`），不跟随本默认值。
- 首屏防闪屏脚本（Web `index.html` 内联脚本、桌面 renderer 入口）必须与 hook/store 使用同一默认值；`localStorage` 读取异常时也按系统偏好兜底。

## 2. 状态所有者与接口

- 默认值只有一个语义来源：`system`。以下位置必须同时持有 `"system"` 字面量，不允许其中一处单独回退到固定深色/浅色：
  - `useTheme` hook 兜底值；
  - Zustand store `theme` 默认值；
  - `WEB_DEFAULT_THEME`（`webThemeSeed.ts`）；
  - Web/桌面首屏内联脚本的 `DEFAULT_THEME`；
  - 资源管理器窗口（`resource-manager.tsx`）与 Coding Plan 内嵌 webview 对话框的 store 兜底值。
- 不为默认值新增配置项或远程开关。

## 3. 验收场景

- 清除 `zcode-theme` 后启动 Web 或桌面：系统浅色 → 首屏与界面为 zai-light；系统深色 → zai-dark；运行中切换系统外观，界面实时跟随。
- 已保存 `zai-dark` 的老用户升级后：仍为深色，不受默认值变化影响。
- 分享链接落地页：无本地主题配置时仍为浅色。
- 设置页/头像菜单选「跟随系统」：与未选择时的表现一致。
