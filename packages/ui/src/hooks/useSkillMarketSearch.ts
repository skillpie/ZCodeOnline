import { useEffect, useState } from "react";
import type { SkillMarketSearchResult } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

/** 市场搜索去抖：与 CommandCenterDialog 内容搜索同一节奏。 */
const SKILL_MARKET_SEARCH_DEBOUNCE_MS = 250;
const SKILL_MARKET_SEARCH_LIMIT = 6;

export interface UseSkillMarketSearchOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 面板当前 query；trim 后非空才发起搜索。 */
  query: string;
  enabled: boolean;
}

export interface SkillMarketSearchState {
  results: SkillMarketSearchResult[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: SkillMarketSearchState = { results: [], loading: false, error: null };

/**
 * SkillPie 技能市场搜索（specs/skill-market.md §5）。
 * renderer 负责 250ms debounce + 请求序号丢弃过期响应；服务经 workspace 解析，
 * 本地 workspace 走本机 host，远程 workspace 代理到远端，保证安装目标与 catalog 同源。
 */
export function useSkillMarketSearch(options: UseSkillMarketSearchOptions): SkillMarketSearchState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    null,
    options.workspaceIdentity,
  );
  const { services, rpcReady } = resolution;
  const query = options.query.trim();
  const enabled = options.enabled && rpcReady;
  const [state, setState] = useState<SkillMarketSearchState>(EMPTY_STATE);

  useEffect(() => {
    if (!enabled || !query) {
      setState(EMPTY_STATE);
      return;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    const timer = setTimeout(() => {
      services.skillMarketService
        .searchSkills({ query, limit: SKILL_MARKET_SEARCH_LIMIT })
        .then((results) => {
          if (!cancelled) {
            setState({ results, loading: false, error: null });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setState({
              results: [],
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
    }, SKILL_MARKET_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, query, services]);

  return state;
}
