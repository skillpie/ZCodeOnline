// 宿主系统语言的权威解析（main 进程）：桌面菜单、GetSystemLocale IPC、隧道兑换
// 等错误文案统一取这里，不得用 renderer/main 的 navigator.language 判语言——
// 两者在 macOS 中文系统下都可能返回 en-US。
import { app } from "electron";
import type { Locale } from "@zcode/shared";

export function resolveSystemApplicationLocale(): Locale {
  // macOS 系统语言为中文时，Electron app.getLocale() 仍可能返回 en-US；
  // 优先读取系统首选语言列表，避免 System default 被误解析成英文。
  const systemLocale = app.getPreferredSystemLanguages?.()[0] ?? app.getLocale();
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}
