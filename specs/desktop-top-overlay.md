# Spec: 左上角顶部浮层与侧边栏折叠入口

> 实现入口：`packages/ui/src/DesktopTopOverlay.tsx`（左上角浮层）、`packages/ui/src/desktopTopOverlayLayout.ts`（折叠按钮变体纯函数）。
> 本 spec 只覆盖左上角 DesktopTopOverlay 的按钮组成与折叠入口平台规则；侧边栏内部交互不在此范围。

## 1. 产品规则

- 左上角浮层自左向右固定为：侧边栏折叠按钮、任务后退、任务前进、新建任务（侧栏收起或文件树展开时显示）、更新入口（有待办更新时显示）。
- **侧边栏折叠按钮在所有运行环境都必须有可见入口**（macOS / Windows / Linux 桌面、桌面浏览器 Web、移动端 Web）：
  - macOS 桌面与 Web：普通图标按钮，图标随可见态在 `PanelLeftClose` / `PanelLeftOpen` 间切换；
  - Windows / Linux 桌面（自绘标题栏）：与 Logo 合并的按钮，hover 显形切换图标。
- 收起侧栏后该按钮必须仍然可见且可点击，保证「收起后必有可见的展开入口」；不得让用户只能依赖命令面板或快捷键找回侧栏。
- 按钮组左缘内边距按平台裁决：macOS 窗口态由交通灯宽度（`macWindowControlsLeftPaddingPx`）让位、全屏态 `pl-5`（收起）/`pl-3`（展开）；Windows/Linux 自绘标题栏 `pl-3 ml-px`；Web 无以上留白来源，固定 `pl-3`，收起与展开保持一致，不得贴死窗口左缘。
- 按钮组垂直对齐基准是 `WorkspaceHeader`（`h-12`）的中心线：Windows/Linux 与 Web 的浮层内层容器用 `h-12`；macOS 因交通灯/全屏语义单独用 `h-14` 加 `pt-1` 微调，不作为 Web 基准。
- 折叠按钮点击触发与快捷键 `toggleSidebar` 相同的 action；tooltip 展示 `workspaceSidebar.toggleSidebar` 文案与当前快捷键。
- 历史背景：Web 此前因平台标志（`isMacDesktop` / `isWindowsDesktop`）缺省不渲染任何折叠入口，收起侧栏后无可见展开路径，属于回归缺陷；本规则将其与桌面端对齐。

## 2. 状态所有者与接口

- 侧边栏可见性所有者不变（app chrome 状态，`WorkspaceShellLayout` 消费 `isSidebarVisible` / `handleToggleSidebar`）；本 spec 只约束入口渲染，不新增状态。
- 折叠按钮变体裁决收敛在纯函数 `resolveSidebarToggleVariant`（`packages/ui/src/desktopTopOverlayLayout.ts`）：输入 `isWindowsDesktop` / `isLinuxDesktop`，输出 `"logoHover" | "plain"`；组件不得内联平台分支。

## 3. 验收场景

- Web（浏览器，`isDesktop` 不传）：左上角渲染 `plain` 折叠按钮；点击收起侧栏后按钮仍在原位且可展开。
- macOS 桌面：行为与现状一致（`plain` 图标按钮）。
- Windows / Linux 桌面：行为与现状一致（`logoHover` Logo hover 变体）。
