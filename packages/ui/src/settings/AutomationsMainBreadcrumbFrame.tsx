import { useState, type ReactNode } from "react";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/** 无面包屑上报时的回退文本；返回 null 表示交给 SettingsHeaderBreadcrumb 正常渲染。 */
export function resolveMainBreadcrumbFallbackLabel(
  items: readonly SettingsBreadcrumbItem[],
  sectionLabel: string,
): string | null {
  return items.length < 2 ? sectionLabel : null;
}

/**
 * 工作区 Automations 不经过 SettingsPage，编辑页的面包屑上报需要 Provider 接收，
 * 所以桌面顶栏只剩空拖拽区；这里让工作区入口复用设置页的同一套面包屑合同。
 */
export function AutomationsMainBreadcrumbFrame({
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
}: {
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);
  // 2026-09-30 修复：skill-market 等没有 SettingsBreadcrumbReporter 的整页视图，
  // items 恒为空且 SettingsHeaderBreadcrumb 对 items<2 返回 null，桌面端 h-12
  // 拖拽条表现为一条空白带。按 specs/skill-market.md §2「桌面端仅保留面包屑标签」
  // 回退渲染 sectionLabel 静态文本；谓词与 SettingsHeaderBreadcrumb 的 items<2
  // 门阈保持镜像，若后者调整需同步更新。
  const fallbackLabel = resolveMainBreadcrumbFallbackLabel(items, sectionLabel);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {isDesktop ? (
          <div
            className="h-12 shrink-0 [app-region:drag]"
            data-testid="automations-main-drag-region"
          >
            {fallbackLabel ? (
              <span
                className="flex h-full items-center px-2.5 text-ui-base/relaxed"
                data-testid="automations-main-breadcrumb-fallback"
              >
                <span aria-current="page" className="truncate px-2 text-foreground">
                  {fallbackLabel}
                </span>
              </span>
            ) : (
              <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
            )}
          </div>
        ) : null}
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
