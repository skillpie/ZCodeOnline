// 自定义代码仓库设置（设置页通用区「代码仓库设置」写入，specs 由产品规则内联）：
// 默认为空 = 左侧边栏不显示「代码仓库」入口；保存后入口出现在技能市场下方，
// 点击经内置浏览器打开（桌面 Browser side pane；Web 端退回新标签）。
// 持久化经 storedUrlSetting 收口；useCodeRepositoryUrl 让设置页与侧边栏保持响应式同步。
import { useSyncExternalStore } from "react";
import { createStoredHttpUrlSetting } from "@/storedUrlSetting.js";

const setting = createStoredHttpUrlSetting("zcode-code-repository-url");

export function loadStoredCodeRepositoryUrl(): string | null {
  return setting.load();
}

/** 保存前先归一化；非法输入不落库并返回 null，由调用方提示。 */
export function saveStoredCodeRepositoryUrl(value: string): string | null {
  return setting.save(value);
}

export function clearStoredCodeRepositoryUrl(): void {
  setting.clear();
}

/** 侧边栏入口可见性与链接的唯一读取口：设置页保存后通过版本号触发重渲染。 */
export function useCodeRepositoryUrl(): string | null {
  useSyncExternalStore(setting.subscribe, setting.getVersion, setting.getVersion);
  return setting.load();
}
