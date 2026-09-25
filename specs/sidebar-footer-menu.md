# Spec: 底部账户菜单的用量与升级入口

> 实现入口：`packages/ui/src/WorkspaceSidebarFooter.tsx`（底部头像菜单）、`packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`（用量/升级菜单项渲染）。
> 本 spec 只约束头像菜单中用量与升级入口的可见性；菜单其余项（语言/主题/缩放/登录）与套餐徽标不在范围内。

## 1. 产品规则

- 底部账户菜单保留「用量统计」入口：点击后进入设置页用量视图（`setPendingSettingsUsageIntent` + `onUsageClick`）。
- **升级入口隐藏**（产品决定）：侧栏与设置页共用的底部菜单不再渲染升级/续费菜单项。
- 隐藏范围仅限底部菜单入口；设置页套餐详情、输入框工具栏套餐余额处的升级入口不受影响，仍按各自规则展示。
- 升级的数据与回调通路保留：`onUpgradeClick` prop 与 hook 的 `upgradeTargetProviderId` 解析不删除；恢复入口时在 `WorkspaceSidebarFooterUsageSummaryContent` 重新渲染菜单项即可，不需要重建 entitlement/pricing 链路。

## 2. 状态所有者与接口

- entitlement/provider 探测所有者不变（`useWorkspaceSidebarFooterUsageSummaryState`），套餐徽标与用量统计继续消费同一份状态。
- 升级入口的显隐是渲染层决定（`WorkspaceSidebarFooterUsageSummaryContent`），不新增状态、不引入配置项。

## 3. 验收场景

- 侧栏底部头像菜单：展示「用量统计」，不展示「升级/续费」。
- 设置页底部头像菜单：同上（与侧栏共用同一渲染组件）。
- 输入框工具栏套餐余额的升级入口：不受影响，仍可打开升级弹窗。
