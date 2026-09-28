/**
 * 工作区头部（WorkspaceHeader）可见性的唯一裁决谓词。
 *
 * 2026-09-27 起可见性只看主视图：主视图为 `chat` 即渲染，桌面、Web 与手机远控
 * 三种壳一致，任务态与草稿态一致，由 variant="draft"|"task" 裁剪任务专属内容
 * （specs/workspace-header-git-tools.md）。此前 Web 草稿态不渲染头部（条件
 * `activeTaskId !== null || isDesktop`），导致 Web 新建任务页缺失右上角 Git 工具
 * 与终端/侧栏入口；决策收敛后不再按平台与活动任务区分。
 * automations / plugin-store / skill-market / code-repository 是自带面包屑框架的整页视图，
 * 不渲染工作区头部；新增主视图默认渲染，与既有行为一致。头部只消费壳层投影的 chrome
 * 状态（git 摘要、终端/侧栏开关），不承载流式或快照语义，草稿态渲染头部不影响
 * web-remote-replayable 恢复链路。
 */
import type { WorkspaceMainView } from "./types.js";

export function shouldRenderWorkspaceHeader(workspaceMainView: WorkspaceMainView): boolean {
  return (
    workspaceMainView !== "automations" &&
    workspaceMainView !== "plugin-store" &&
    workspaceMainView !== "skill-market" &&
    workspaceMainView !== "code-repository"
  );
}
