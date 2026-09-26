// SkillPie 技能市场地址的唯一解析出口（specs/skill-market.md §2）：
// 内嵌视图（SkillMarketEmbeddedView）与侧边栏外链入口共用同一 base，
// 避免两处地址漂移；本地联调用 VITE_SKILL_MARKET_URL 覆盖时对两者同时生效。
import { DEFAULT_SKILL_MARKET_URL } from "@zcode/shared";

interface SkillMarketImportMetaEnv {
  VITE_SKILL_MARKET_URL?: string;
}

function readImportMetaEnv(): SkillMarketImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: SkillMarketImportMetaEnv }).env ??
    {}) as SkillMarketImportMetaEnv;
}

function resolveSkillMarketUrl(): string {
  // 本地联调可指向自部署 skillpie（如 http://localhost:3001）；生产固定 skillpie.cn。
  const override = readImportMetaEnv().VITE_SKILL_MARKET_URL?.trim();
  if (override) {
    try {
      return new URL(override).toString();
    } catch {
      // 非法 override 忽略，回退线上地址。
    }
  }
  return DEFAULT_SKILL_MARKET_URL;
}

/** 市场首页：内嵌视图默认加载地址。 */
export const SKILL_MARKET_URL = resolveSkillMarketUrl();

/** 技能列表页：侧边栏「技能市场」入口交系统浏览器打开的目标地址。 */
export const SKILL_MARKET_SKILLS_URL = new URL("/skills", SKILL_MARKET_URL).toString();
