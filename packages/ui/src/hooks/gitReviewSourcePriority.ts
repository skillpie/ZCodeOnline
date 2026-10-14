/**
 * 头部审查按钮的来源裁决 —— 从 useGitRepository 拆出（该文件有 max-lines 门禁）。
 * 纯函数：只依赖 GitPane 数据集形状，不触碰 hooks 与服务。
 */
import type { GitPaneDataset, GitRepositorySourceId } from "./useGitRepository.js";

/** 来源优先级（2026-10-14 用户决策）：暂存(unstaged) → 提交(staged) → 推送(branch)，按 Tab 现行文案。 */
const GIT_REVIEW_SOURCE_PRIORITY: readonly GitRepositorySourceId[] = [
  "unstaged",
  "staged",
  "branch",
];

/**
 * 按暂存→提交→推送优先级取第一个非空来源；全空返回 null（调用方保持现有选中）。
 * 非空口径与 GitPane 三段 Tab 的列表一致：来源数据集内任一分节存在文件变更。
 */
export function resolveGitReviewSourceIdByPriority(
  datasets: Record<GitRepositorySourceId, GitPaneDataset>,
): GitRepositorySourceId | null {
  return (
    GIT_REVIEW_SOURCE_PRIORITY.find((sourceId) =>
      datasets[sourceId].sections.some((section) => section.changes.length > 0),
    ) ?? null
  );
}
