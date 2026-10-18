// 语言偏好的 localStorage 读写收口：ZCodeIntlProvider 是唯一写入方（切换语言时落盘），
// ErrorBoundary、桌面隧道门禁等未挂 Provider 的挂载点只读此偏好来对齐主界面语言。
// key 与合法值判定收在此处，避免多处手写字符串字面量造成漂移。
import type { Locale, LocalePreference } from "@zcode/shared";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

export function readStoredLocalePreference(): LocalePreference | null {
  const raw = readSafeLocalStorage(LOCALE_PREFERENCE_KEY);
  return raw === "system" || raw === "zh-CN" || raw === "en-US" ? raw : null;
}

export function writeStoredLocalePreference(preference: LocalePreference): void {
  writeSafeLocalStorage(LOCALE_PREFERENCE_KEY, preference);
}

/** URL flag / 显式存储偏好对应的语言；system 或无偏好返回 null，由调用方再解析系统语言。 */
export function resolveExplicitStoredLocale(initialLocale?: Locale): Locale | null {
  if (initialLocale) {
    return initialLocale;
  }
  const stored = readStoredLocalePreference();
  return stored === "zh-CN" || stored === "en-US" ? stored : null;
}
