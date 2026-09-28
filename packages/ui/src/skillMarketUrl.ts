// 技能市场链接设置（specs/skill-market.md §1）：设置页技能区的「技能市场设置」弹窗写入，
// 侧边栏入口与内嵌视图从这里解析链接。localStorage 是唯一持久化读写路径；
// 构建期 VITE_SKILL_MARKET_URL 只作为未自定义时的站点基址回退（本地联调自部署 skillpie）。
import { DEFAULT_SKILL_MARKET_URL } from "@zcode/shared";

const STORAGE_KEY = "zcode-skill-market-url";
/** 侧边栏入口默认落到技能列表页（specs/skill-market.md §1）。 */
const DEFAULT_ENTRY_PATH = "/skills";

/** 默认市场链接；未自定义时侧边栏「技能市场」入口打开这里。 */
export const DEFAULT_SKILL_MARKET_ENTRY_URL = new URL(
  DEFAULT_ENTRY_PATH,
  DEFAULT_SKILL_MARKET_URL,
).toString();

function readBuildEnvMarketBaseUrl(): string | null {
  const env = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ??
    {}) as Record<string, string | undefined>;
  return env.VITE_SKILL_MARKET_URL?.trim() || null;
}

/** 归一化市场链接：仅接受 http(s) 完整地址，返回规范化字符串；非法输入返回 null。 */
export function normalizeSkillMarketUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function loadStoredSkillMarketUrl(): string | null {
  try {
    return normalizeSkillMarketUrl(localStorage.getItem(STORAGE_KEY) ?? "");
  } catch {
    return null;
  }
}

/** 保存前先归一化；非法输入不落库并返回 null，由调用方提示。 */
export function saveStoredSkillMarketUrl(value: string): string | null {
  const normalized = normalizeSkillMarketUrl(value);
  if (!normalized) {
    return null;
  }
  localStorage.setItem(STORAGE_KEY, normalized);
  return normalized;
}

export function clearStoredSkillMarketUrl(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 移除失败不影响语义：读不到即视为未自定义。
  }
}

/** 侧边栏入口链接：用户自定义优先，其次构建期站点基址 + /skills，最后线上默认。 */
export function resolveSkillMarketEntryUrl(): string {
  const stored = loadStoredSkillMarketUrl();
  if (stored) {
    return stored;
  }
  const envBase = readBuildEnvMarketBaseUrl();
  if (envBase) {
    const normalized = normalizeSkillMarketUrl(envBase);
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
    const normalized = normalizeSkillMarketUrl(envBase);
    if (normalized) {
      trustedOrigins.add(new URL(normalized).origin);
    }
  }
  return trustedOrigins.has(entryOrigin) ? entryOrigin : null;
}
