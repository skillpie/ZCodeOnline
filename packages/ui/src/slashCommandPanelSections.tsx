import { useMemo } from "react";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import {
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";

/** 「技能市场」分区的数据面（specs/skill-market.md §5）。 */
export interface SkillMarketSectionInput {
  /** 面板是否有非空查询；无查询时整个分组不出现。 */
  hasQuery: boolean;
  suggestions: PromptInputSuggestionItem[];
  resultsByName: Map<
    string,
    { category: string | null; ownerDisplayName: string; downloadCount: number }
  >;
  loading: boolean;
  error: string | null;
}

export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
  market: SkillMarketSectionInput,
): MentionPanelSection[] {
  return useMemo(() => {
    const marketSection: MentionPanelSection | null = market.hasQuery
      ? {
          id: "skill-market",
          title: intl.formatMessage({ id: "chat.slash.market.title" }),
          options: market.suggestions.map<MentionPanelOption>((suggestion) => {
            const meta = market.resultsByName.get(suggestion.value);
            return {
              id: suggestion.id,
              label: suggestion.label,
              description: suggestion.description,
              content: (
                <span className="min-w-0 flex-1 flex items-center gap-2">
                  <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                    {suggestion.label}
                  </span>
                  <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                    {suggestion.description}
                  </span>
                  {meta ? (
                    <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                      {formatSkillMarketMeta(
                        intl,
                        meta.category,
                        meta.ownerDisplayName,
                        meta.downloadCount,
                      )}
                    </span>
                  ) : null}
                </span>
              ),
            };
          }),
          loading: market.loading,
          loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
          emptyText: market.error
            ? intl.formatMessage({ id: "chat.slash.market.error" })
            : intl.formatMessage({ id: "chat.slash.market.empty" }),
        }
      : null;

    return [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `/${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`/${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `$${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`$${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: skillsLoading,
        loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      {
        id: "subagents",
        title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
        options: filteredSubagentSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: suggestion.value,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {suggestion.value}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: subagentsLoading,
        emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
        errorText: subagentsError,
      },
      ...(marketSection ? [marketSection] : []),
    ];
  }, [
    commandsLength,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    filteredSubagentSuggestions,
    intl,
    market,
    skillsError,
    skillsLoading,
    subagentsError,
    subagentsLoading,
  ]);
}

function formatSkillMarketMeta(
  intl: IntlInstance,
  category: string | null,
  ownerDisplayName: string,
  downloadCount: number,
): string {
  const parts = [
    category,
    ownerDisplayName,
    intl.formatMessage({ id: "chat.slash.market.downloads" }, { count: downloadCount }),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}
