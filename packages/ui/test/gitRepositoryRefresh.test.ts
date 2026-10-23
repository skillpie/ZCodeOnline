import { describe, expect, it } from "vitest";
import {
  buildRepositoryDatasets,
  shouldRefreshLiveGitData,
} from "../src/hooks/useGitRepository.js";

describe("shouldRefreshLiveGitData", () => {
  it("refreshes on initial load and workspace changes", () => {
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/repo-a",
        workspaceKey: "/repo-a",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: true,
      }),
    ).toBe(true);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-b",
          workspaceKey: "/repo-b",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("refreshes when the pane opens or user triggers an explicit refresh", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("refreshes when workspace identity changes even if the remote path is the same", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server-a:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server-b:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("does not refresh when only the pane closes or task-local data changes", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(false);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(false);
  });

  it("does not refresh disconnected remote placeholders until workspace RPC is available", () => {
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/root",
        workspaceKey: "remote:ssh:root@server:/root",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: false,
      }),
    ).toBe(false);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: false,
        },
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });
});

describe("buildRepositoryDatasets", () => {
  const baseChange = {
    path: "/repo/asset.bin",
    repoRelativePath: "asset.bin",
    workspaceRelativePath: "asset.bin",
    kind: "added" as const,
    added: 0,
    removed: 0,
    isStaged: false,
    isUntracked: true,
    isConflicted: false,
  };

  it("keeps non-reviewable untracked entries in review datasets to align with git status", () => {
    // 口径对齐（fengqun-scm）：二进制/空文件等零行数未跟踪条目与提交弹窗、isDirty
    // 同源全量进数据集与计数，「不可审查」只表现为卡片不可展开，不在数据集裁剪。
    const datasets = buildRepositoryDatasets({
      unstagedChanges: [
        { ...baseChange, section: "untracked", isReviewable: false },
        {
          ...baseChange,
          path: "/repo/text.txt",
          repoRelativePath: "text.txt",
          workspaceRelativePath: "text.txt",
          added: 3,
          section: "untracked",
          isReviewable: true,
        },
      ],
      stagedChanges: [],
      branchComparison: {
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      },
    });

    const untrackedPaths =
      datasets.unstaged.sections
        .find((section) => section.id === "untracked")
        ?.changes.map((change) => change.workspaceRelativePath) ?? [];
    expect(untrackedPaths).toEqual(["asset.bin", "text.txt"]);
  });

  it("keeps all sections when every entry is reviewable", () => {
    const datasets = buildRepositoryDatasets({
      unstagedChanges: [
        { ...baseChange, section: "untracked", isReviewable: true },
        {
          ...baseChange,
          path: "/repo/edited.txt",
          repoRelativePath: "edited.txt",
          workspaceRelativePath: "edited.txt",
          kind: "modified" as const,
          added: 1,
          removed: 1,
          isUntracked: false,
          section: "unstaged" as const,
          isReviewable: true,
        },
      ],
      stagedChanges: [
        {
          ...baseChange,
          path: "/repo/staged.txt",
          repoRelativePath: "staged.txt",
          workspaceRelativePath: "staged.txt",
          kind: "modified" as const,
          added: 2,
          isUntracked: false,
          section: "staged" as const,
          isStaged: true,
          isReviewable: true,
        },
      ],
      branchComparison: {
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      },
    });

    expect(datasets.unstaged.sections.map((section) => section.id)).toEqual([
      "unstaged",
      "untracked",
    ]);
    expect(datasets.staged.sections.map((section) => section.id)).toEqual(["staged"]);
  });
});
