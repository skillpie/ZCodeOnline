// 技能市场链接设置（specs/skill-market.md §1）：设置页技能区的「技能市场设置」弹窗写入，
// 侧边栏入口与内嵌视图从这里解析链接。持久化经 storedUrlSetting 收口；
// 构建期 VITE_SKILL_MARKET_URL 只作为未自定义时的站点基址回退（本地联调自部署 skillpie）。
import { DEFAULT_SKILL_MARKET_URL } from "@zcode/shared";
import { createStoredHttpUrlSetting, normalizeExternalHttpUrl } from "@/storedUrlSetting.js";

const setting = createStoredHttpUrlSetting("zcode-skill-market-url");
/** 侧边栏入口默认落到技能列表页（specs/skill-market.md §1）。 */
const DEFAULT_ENTRY_PATH = "/skills";

/** 默认市场链接；未自定义时侧边栏「技能市场」入口打开这里。 */
export const DEFAULT_SKILL_MARKET_ENTRY_URL = new URL(
  DEFAULT_ENTRY_PATH,
  DEFAULT_SKILL_MARKET_URL,
).toString();

/** 归一化市场链接：仅接受 http(s) 完整地址，返回规范化字符串；非法输入返回 null。 */
export function normalizeSkillMarketUrl(value: string): string | null {
  return normalizeExternalHttpUrl(value);
}

function readBuildEnvMarketBaseUrl(): string | null {
  const env = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ??
    {}) as Record<string, string | undefined>;
  return env.VITE_SKILL_MARKET_URL?.trim() || null;
}

export function loadStoredSkillMarketUrl(): string | null {
  return setting.load();
}

export function saveStoredSkillMarketUrl(value: string): string | null {
  return setting.save(value);
}

export function clearStoredSkillMarketUrl(): void {
  setting.clear();
}

/** 侧边栏入口链接：用户自定义优先，其次构建期站点基址 + /skills，最后线上默认。 */
export function resolveSkillMarketEntryUrl(): string {
  const stored = setting.load();
  if (stored) {
    return stored;
  }
  const envBase = readBuildEnvMarketBaseUrl();
  if (envBase) {
    const normalized = normalizeExternalHttpUrl(envBase);
    if (normalized) {
      return new URL(DEFAULT_ENTRY_PATH, normalized).toString();
    }
  }
  return DEFAULT_SKILL_MARKET_ENTRY_URL;
}

/**
 * 免登握手（SSO）只在构建期可信 origin 上进行：运行期可被任意改写的自定义市场链接
 * 不能接收平台 JWT（specs/skill-market.md §1 的 targetOrigin 严格回包契约）。
 * 自定义链接正常内嵌加载，但走市场自身登录。返回 null 表示当前入口不可信、禁用握手。
 */
export function resolveTrustedSkillMarketSsoOrigin(entryUrl: string): string | null {
  let entryOrigin: string;
  try {
    entryOrigin = new URL(entryUrl).origin;
  } catch {
    return null;
  }
  const trustedOrigins = new Set<string>([new URL(DEFAULT_SKILL_MARKET_URL).origin]);
  const envBase = readBuildEnvMarketBaseUrl();
  if (envBase) {
    const normalized = normalizeExternalHttpUrl(envBase);
    if (normalized) {
      trustedOrigins.add(new URL(normalized).origin);
    }
  }
  return trustedOrigins.has(entryOrigin) ? entryOrigin : null;
}
