// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStoredLocalePreference,
  resolveExplicitStoredLocale,
  writeStoredLocalePreference,
} from "@/i18n/localePreferenceStorage.js";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("localePreferenceStorage", () => {
  it("读写显式语言偏好与 system 偏好", () => {
    writeStoredLocalePreference("zh-CN");
    expect(readStoredLocalePreference()).toBe("zh-CN");
    expect(resolveExplicitStoredLocale()).toBe("zh-CN");

    writeStoredLocalePreference("system");
    expect(readStoredLocalePreference()).toBe("system");
    // system 不是显式语言，调用方需再解析系统语言。
    expect(resolveExplicitStoredLocale()).toBeNull();
  });

  it("无偏好或非法值按无偏好处理", () => {
    expect(readStoredLocalePreference()).toBeNull();
    localStorage.setItem("zcode-locale-preference", "fr-FR");
    expect(readStoredLocalePreference()).toBeNull();
    expect(resolveExplicitStoredLocale()).toBeNull();
  });

  it("显式偏好解析时 URL flag 优先于存储偏好", () => {
    writeStoredLocalePreference("zh-CN");
    expect(resolveExplicitStoredLocale("en-US")).toBe("en-US");
  });
});
