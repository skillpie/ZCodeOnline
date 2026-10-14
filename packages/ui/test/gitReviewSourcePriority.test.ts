import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { GitPaneDataset } from "../src/hooks/useGitRepository.js";
import { resolveGitReviewSourceIdByPriority } from "../src/hooks/gitReviewSourcePriority.js";

function createDataset(sourceId: GitPaneDataset["id"], fileCounts: number[]): GitPaneDataset {
  return {
    id: sourceId,
    readonly: sourceId === "branch",
    sections: fileCounts.map((count, index) => ({
      id: sourceId,
      changes: Array.from({ length: count }, (_, fileIndex) => ({
        path: `${sourceId}-${index}-${fileIndex}.ts`,
        added: 1,
        removed: 0,
        diff: null,
      })),
    })),
  };
}

function createDatasets(
  overrides: Partial<Record<GitPaneDataset["id"], number[]>>,
): Record<GitPaneDataset["id"], GitPaneDataset> {
  return {
    unstaged: createDataset("unstaged", overrides.unstaged ?? [0]),
    staged: createDataset("staged", overrides.staged ?? [0]),
    branch: createDataset("branch", overrides.branch ?? [0]),
  };
}

describe("resolveGitReviewSourceIdByPriority（2026-10-14 头部审查按钮）", () => {
  it("优先级暂存 > 提交 > 推送：多来源非空时取最前者", () => {
    assert.equal(
      resolveGitReviewSourceIdByPriority(
        createDatasets({ unstaged: [2], staged: [3], branch: [4] }),
      ),
      "unstaged",
    );
    assert.equal(
      resolveGitReviewSourceIdByPriority(createDatasets({ staged: [3], branch: [4] })),
      "staged",
    );
  });

  it("全部为空时返回 null（调用方保持现有选中）", () => {
    assert.equal(resolveGitReviewSourceIdByPriority(createDatasets({})), null);
  });

  it("跨分节聚合：单来源多个分节里任一有文件即非空", () => {
    // unstaged 来源的分节为 unstaged/untracked/conflicted，任一分节有文件都算非空。
    assert.equal(
      resolveGitReviewSourceIdByPriority(createDatasets({ unstaged: [0, 1] })),
      "unstaged",
    );
    assert.equal(resolveGitReviewSourceIdByPriority(createDatasets({ unstaged: [0, 0] })), null);
  });

  it("推送（branch）兜底：前两级为空且领先提交存在时取 branch", () => {
    assert.equal(resolveGitReviewSourceIdByPriority(createDatasets({ branch: [2] })), "branch");
  });
});
