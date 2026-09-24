import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranchComparison,
  GitChangeSectionId,
  GitChangeSourceId,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitRepositorySummary,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";

// 2026-09 产品决策：Git 审阅面板来源为 未暂存/已暂存/已提交 三段（分段切换）。
// branch 数据集承载「已提交未推送」语义（git diff <upstream>...HEAD），
// last-turn 快照来源已随 specs/git-review-pane.md 移除；
// 共享协议里的 GitChangeSourceId 仍含四个值（服务契约不动），UI 层不再生产 last-turn。
export type GitRepositorySourceId = Extract<GitChangeSourceId, "unstaged" | "staged" | "branch">;

interface RepositoryDatasets {
  unstaged: GitPaneDataset;
  staged: GitPaneDataset;
  branch: GitPaneDataset;
}

const EMPTY_BRANCH_COMPARISON: GitBranchComparison = {
  baseRef: null,
  headRef: null,
  comparisonLabel: null,
  changes: [],
};

interface GitLiveDataRefreshInput {
  workspacePath: string;
  workspaceKey: string;
  includeExtendedData: boolean;
  refreshToken: string | number | boolean | null;
  workspaceRpcEnabled: boolean;
}

export interface GitPaneFileChange extends GitFileChange {
  diff: GitDiffResult | null;
}

export interface GitPaneSection {
  id: GitChangeSectionId;
  changes: GitPaneFileChange[];
}

export interface GitPaneDataset {
  id: GitRepositorySourceId;
  readonly: boolean;
  sections: GitPaneSection[];
  comparisonLabel?: string | null;
  turnIndex?: number | null;
}

export interface GitPaneSourceOption {
  id: GitRepositorySourceId;
  count: number;
  readonly: boolean;
  disabled: boolean;
  comparisonLabel?: string | null;
}

export interface GitPaneRepositoryState {
  workspaceKey: string;
  summary: GitRepositorySummary;
  identity: GitIdentity;
  placeholder: {
    enabled: boolean;
  };
  loading: boolean;
  error: string | null;
  revision: number;
  sourceOptions: GitPaneSourceOption[];
  datasets: Record<GitRepositorySourceId, GitPaneDataset>;
}

const SECTION_ORDER_BY_SOURCE: Record<GitRepositorySourceId, readonly GitChangeSectionId[]> = {
  unstaged: ["unstaged", "untracked", "conflicted"],
  staged: ["staged"],
  branch: ["branch"],
};

const EMPTY_IDENTITY: GitIdentity = {
  userName: null,
  userEmail: null,
  nameSource: null,
  emailSource: null,
  scopeLabel: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function sumSectionCount(sections: readonly GitPaneSection[]): number {
  return sections.reduce((count, section) => count + section.changes.length, 0);
}

function createEmptySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  };
}

function createEmptyDataset(id: GitRepositorySourceId, readonly: boolean): GitPaneDataset {
  return {
    id,
    readonly,
    sections: [],
    comparisonLabel: null,
    turnIndex: null,
  };
}

function createEmptyDatasets(): Record<GitRepositorySourceId, GitPaneDataset> {
  return {
    unstaged: createEmptyDataset("unstaged", false),
    staged: createEmptyDataset("staged", false),
    branch: createEmptyDataset("branch", true),
  };
}

function buildSourceOptions(
  datasets: Record<GitRepositorySourceId, GitPaneDataset>,
): GitPaneSourceOption[] {
  return [
    {
      id: "unstaged",
      count: sumSectionCount(datasets.unstaged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "staged",
      count: sumSectionCount(datasets.staged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "branch",
      count: sumSectionCount(datasets.branch.sections),
      readonly: true,
      disabled: false,
      comparisonLabel: datasets.branch.comparisonLabel,
    },
  ];
}

function createInitialState(
  workspacePath: string,
  options?: {
    workspaceKey?: string;
    loading?: boolean;
    error?: string | null;
    revision?: number;
  },
): GitPaneRepositoryState {
  const datasets = createEmptyDatasets();
  return {
    workspaceKey: options?.workspaceKey ?? workspacePath,
    summary: createEmptySummary(workspacePath),
    identity: EMPTY_IDENTITY,
    placeholder: {
      enabled: false,
    },
    loading: options?.loading ?? true,
    error: options?.error ?? null,
    revision: options?.revision ?? 0,
    sourceOptions: buildSourceOptions(datasets),
    datasets,
  };
}

function toPaneFileChange(
  change: GitFileChange,
  diff: GitDiffResult | null = null,
): GitPaneFileChange {
  return {
    ...change,
    diff,
  };
}

function buildSectionsForSource(
  sourceId: GitRepositorySourceId,
  changes: GitFileChange[],
): GitPaneSection[] {
  const grouped = new Map<GitChangeSectionId, GitPaneFileChange[]>();
  for (const change of changes) {
    const sectionChanges = grouped.get(change.section) ?? [];
    sectionChanges.push(toPaneFileChange(change));
    grouped.set(change.section, sectionChanges);
  }

  return SECTION_ORDER_BY_SOURCE[sourceId]
    .map((sectionId) => {
      const sectionChanges = grouped.get(sectionId);
      if (!sectionChanges || sectionChanges.length === 0) {
        return null;
      }

      sectionChanges.sort((left, right) =>
        left.workspaceRelativePath.localeCompare(right.workspaceRelativePath),
      );

      return {
        id: sectionId,
        changes: sectionChanges,
      };
    })
    .filter((section): section is GitPaneSection => Boolean(section));
}

function buildRepositoryDatasets(options: {
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison;
}): RepositoryDatasets {
  return {
    unstaged: {
      id: "unstaged",
      readonly: false,
      sections: buildSectionsForSource("unstaged", options.unstagedChanges),
    },
    staged: {
      id: "staged",
      readonly: false,
      sections: buildSectionsForSource("staged", options.stagedChanges),
    },
    branch: {
      id: "branch",
      readonly: true,
      sections: buildSectionsForSource("branch", options.branchComparison.changes),
      comparisonLabel: options.branchComparison.comparisonLabel,
    },
  };
}

function shouldRefreshLiveGitData(
  previous: GitLiveDataRefreshInput | null,
  next: GitLiveDataRefreshInput,
): boolean {
  if (!next.workspaceRpcEnabled) {
    return false;
  }

  if (!previous || !previous.workspaceRpcEnabled) {
    return true;
  }

  if (previous.workspacePath !== next.workspacePath) {
    return true;
  }

  if (previous.workspaceKey !== next.workspaceKey) {
    return true;
  }

  if (previous.refreshToken !== next.refreshToken) {
    return true;
  }

  // 关键业务逻辑：Git pane 关闭时不应该因为“少拿 identity/branch 对比”反向触发一轮真实 Git。
  // 只有从关闭 -> 打开时，才补拉扩展数据；task 的切换则只走本地数据重组。
  return !previous.includeExtendedData && next.includeExtendedData;
}

export function useGitRepository(options: {
  workspacePath: string;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const {
    workspacePath,
    includeExtendedData = false,
    refreshToken = null,
    remoteSessionId: preferredRemoteSessionId = null,
    remoteTarget,
    workspaceIdentity = null,
  } = options;
  const { gitService } = useServices();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
  });
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const [repositoryState, setRepositoryState] = useState<GitPaneRepositoryState>(() =>
    createInitialState(workspacePath, { workspaceKey }),
  );
  const requestVersionRef = useRef(0);
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);

  useEffect(() => {
    const nextRefreshInput: GitLiveDataRefreshInput = {
      workspacePath,
      workspaceKey,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
    };

    if (!workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = nextRefreshInput;
      // 断连远端 workspace 可以展示 Git 面板空壳，但不能在 session 未恢复前
      // 主动查询远端 Git，否则会把断连代理错误放大成每次首屏挂载的日志噪音。
      setRepositoryState((current) =>
        createInitialState(workspacePath, {
          workspaceKey,
          loading: false,
          error: null,
          revision: current.revision,
        }),
      );
      return;
    }

    const shouldRefresh = shouldRefreshLiveGitData(
      lastLiveRefreshInputRef.current,
      nextRefreshInput,
    );
    lastLiveRefreshInputRef.current = nextRefreshInput;
    if (!shouldRefresh) {
      return;
    }

    let disposed = false;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setRepositoryState((current) =>
      current.workspaceKey === workspaceKey
        ? {
            ...current,
            loading: true,
            error: null,
          }
        : createInitialState(workspacePath, { workspaceKey }),
    );

    // agent 写文件会触发 Git 自动刷新。这里不能拆成 summary/unstaged/staged
    // 三个 RPC，因为服务端每个 RPC 都会重新跑 git status，日志里会形成一轮一组三连。
    // 统一走 refresh，让一次状态快照产出 header 和 Git pane 需要的基础数据。
    const refreshPromise = gitService.refresh({
      workspacePath,
      includeIdentity: includeExtendedData,
      // 「已提交」段（specs/git-review-pane.md）依赖 upstream...HEAD 对比，
      // 只在真正展开 Git pane 后随扩展数据一起拉取，header 常驻态不做这次 git diff。
      includeBranchComparison: includeExtendedData,
    });

    // 关键业务逻辑：header 常驻时只需要 summary + staged/unstaged 统计；
    // identity 与 branch 对比只在真正展开 Git pane 后再拉取，避免首屏预取额外 Git 数据。
    void refreshPromise
      .then(({ summary, identity, unstagedChanges, stagedChanges, branchComparison }) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const datasets = buildRepositoryDatasets({
          unstagedChanges,
          stagedChanges,
          branchComparison: branchComparison ?? EMPTY_BRANCH_COMPARISON,
        });

        setRepositoryState({
          workspaceKey,
          summary,
          identity: identity ?? EMPTY_IDENTITY,
          placeholder: {
            enabled: false,
          },
          loading: false,
          error: null,
          revision: requestVersion,
          sourceOptions: buildSourceOptions(datasets),
          datasets,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", {
          workspacePath,
          error: message,
        });
        setRepositoryState((current) => ({
          ...createInitialState(workspacePath, {
            workspaceKey,
            loading: false,
            error: message,
            revision: current.revision,
          }),
        }));
      });

    return () => {
      disposed = true;
    };
  }, [
    gitService,
    includeExtendedData,
    refreshToken,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  return useMemo(() => {
    // useEffect 在 workspace 切换后的 commit 才会清理旧状态。render 阶段先按
    // workspaceKey 投影为空状态，避免旧机器的 Git 路径通过新远端 fileWatcherService 注册。
    return repositoryState.workspaceKey === workspaceKey
      ? repositoryState
      : createInitialState(workspacePath, { workspaceKey });
  }, [repositoryState, workspaceKey, workspacePath]);
}
