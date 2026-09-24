import type { SkillMarketSearchResult } from "@zcode/shared";
import type { MentionItem } from "../mentionTypes.js";

/** SkillPie 市场候选在两个面板（/ 与 $）共用的 id 前缀；选中时据此打开原生详情弹窗。 */
export const SKILL_MARKET_ITEM_ID_PREFIX = "skill-market:";

/**
 * 市场候选复用 skills category 的面板渲染与键盘导航语义，但 data.source 标记
 * "skill-market"，且 markdown 恒为空串——市场项选中即打开详情弹窗，永不插入 mention。
 */
export function mapSkillMarketResultsToMentionItems(
  results: readonly SkillMarketSearchResult[],
): MentionItem[] {
  return results.flatMap((result) => {
    const value = result.normalizedName.trim();
    if (!value) {
      return [];
    }
    return [
      {
        id: `${SKILL_MARKET_ITEM_ID_PREFIX}${value}`,
        category: "skills",
        label: result.name || value,
        description: result.description,
        value,
        markdown: "",
        keywords: [
          ...new Set([
            value,
            result.name,
            result.category ?? "",
            result.ownerDisplayName,
            result.description,
            "skill market",
            "技能市场",
          ]),
        ],
        data: { source: "skill-market" },
      },
    ];
  });
}

export function isSkillMarketMentionItem(item: Pick<MentionItem, "id">): boolean {
  return item.id.startsWith(SKILL_MARKET_ITEM_ID_PREFIX);
}

export function getSkillMarketMentionNormalizedName(id: string): string {
  return id.slice(SKILL_MARKET_ITEM_ID_PREFIX.length);
}
