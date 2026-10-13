# 计划：主工作区会话列表合并 worktree 会话 + worktree 行标识

## 目标

fengqun-scm 这类主树工作区的会话列表合并展示其 `.worktrees/*` 下各 worktree 里创建的会话；这些会话行左侧显示 worktree 小图标，hover 显示属于哪个 worktree。

**关键交互（明确）**：点击合并列表中的 worktree 会话时，**自动打开/切换到该 worktree 的工作区标签页并在那里恢复会话**（复用既有跨工作区导航 `ensureTaskNavigationWorkspace`，automations 运行历史已用同一机制）；绝不在主树 cwd 上下文里恢复 worktree 会话（否则后续对话会跑错目录）。

## 现状事实（调研结论）

- 侧栏会话列表：`useWorkspaceTaskLists` 按每个工作区 tab 构建单一 scope（workspacePath 精确等值匹配 workspace_key），sessions-index 订阅与 tasks-index 查询都按该 scope；worktree 的会话在它自己的 workspace_key 桶里，主树查不到。
- 缓存 descriptor 已天然支持多 workspaceKey（`workspaceScopes` 数组 + `normalizeTaskListWorkspaceScopes` 去重排序；失效按 `descriptor.workspaceKeys` 匹配）——合并是多 scope 聚合，不需要改缓存结构。
- 会话行（TaskListItem）已能拿到 `task.workspacePath` 与组级 `workspacePath` prop，且 `task.workspacePath` 已在 memo 比较器中——行标识可由现有 props 派生，无需新增 props。
- worktree 发现：`gitService.listWorktrees({ workspacePath })` 已存在（分支切换器在用）。
- 跨工作区打开任务：`ensureTaskNavigationWorkspace` 已存在（WorkspaceShellLayout 的 automations 运行历史在用，自动补开目标工作区 tab 并激活任务）。

## 设计

```text
WorkspaceSidebar
  └─ useWorkspaceWorktreeScopes（新 hook + 轻量 store）
       │  对每个 project workspace：gitService.listWorktrees →
       │  过滤 path ∈ <workspacePath>/.worktrees/*（realpath 双形态兼容）
       ▼  产出 Map<workspacePath, WorktreeDir[]（dirName+path）>，随 tabs 变化刷新；
         worktree 增删/重命名后由 useGitWorktreeActions 触发 store.refresh(path)
useWorkspaceTaskLists
  └─ scope 构建：每工作区 scopes = [自身, ...其 worktree 目录]
       ▼  sessions-index 订阅与 tasks-index 查询覆盖全部 scope
     聚合：以主 scope 为键合并为单一 group（items 带各自 workspacePath），
     排序沿用现有 ordering，「显示更多」分页在合并集上生效
TaskListItem（侧栏会话行）
  └─ task.workspacePath 位于 <组路径>/.worktrees/ 下 → 标题左侧显示
     FolderGit2 小图标，title = 「worktree：{目录名}」
点击 worktree 会话行
  └─ ensureTaskNavigationWorkspace(task.workspacePath) → 切换/打开该 worktree
     工作区标签页 → 在该工作区内激活并恢复会话（cwd = worktree 目录，正确）
```

- 无身份记录、无 config 写入、无 host 改动（gitService.listWorktrees 已存在）。
- worktree 自己的工作区标签页（若打开）保持自身 scope 的列表，不合并（避免主树任务混入）。

## 实施步骤

1. **新 hook + store** `packages/ui/src/hooks/useWorkspaceWorktreeScopes.ts`：
   - 轻量 zustand store：`Record<workspacePath, { dirs: { dirName, path }[]; fetchedAt }>` + `refresh(path)`；
   - hook：对传入的 project workspace tabs 逐个发现（listWorktrees → 过滤 `.worktrees/` 前缀，realpath 双形态兼容），失败静默降级为空；tabs 变化自动补拉；
   - `useGitWorktreeActions` 的 add/remove/rename 成功后调用 `refresh(path)`。
2. **useWorkspaceTaskLists.ts**：scope 构建处用上述 store 把每工作区扩展为多 scope；`buildWorkspaceGroupsFromSessions` 聚合逻辑改为「按主 scope 输出单一 group，items 合并各 scope 且保留各自 workspacePath」，分页/total 在合并集上计算；`buildTaskListResult` 调用参数相应调整。
3. **侧栏会话行点击导航**：WorkSidebar 的 TaskList 行点击处，若 `task.workspacePath` ≠ 当前工作区路径（即 worktree 会话），改走 `ensureTaskNavigationWorkspace` 打开/激活对应 worktree 工作区并在其内激活任务；主树自身任务行为不变。
4. **TaskListItem.tsx**：由 `task.workspacePath` 与组级 `workspacePath` 派生 `isWorktreeTask`（路径前缀 `<组路径>/.worktrees/`，双分隔符兼容），为真时在标题左侧渲染 `FolderGit2`（size-3.5，text-foreground-subtle），`title="worktree：{目录名}（完整路径）"`；不新增 props，memo 比较器无需变更。
5. **i18n**：tooltip 文案 `git.taskList.worktreeTooltip`（zh：`worktree：{name}`；en：`worktree: {name}`）。
6. **spec**：`specs/worktree.md` 增补「会话列表合并与行标识」一节。

## 边界与不变量

- 不改 tabStore / Host 附件 / 会话键控：worktree 的会话仍归属其自身 workspaceKey，只是查询聚合跨 scope；点击导航保证"在哪个工作区恢复，cwd 就是哪个"。
- 主树标签页未打开时（只有 worktree tab）：worktree tab 维持自身 scope 的列表，不合并。
- 发现失败（非 git 仓库 / git 不可用）静默降级为无 worktree scope，行为与现状一致。
- 移除 worktree 后 `refresh` 触发重发现，其会话行随之从主列表消失（任务数据仍在 sqlite，不删除）。

## 验收

1. fengqun-scm 主工作区列表同时显示主树与 `.worktrees/*` 的会话，按现有排序统一排列；
2. worktree 会话行标题左侧有 worktree 图标，hover 显示目录名；
3. **点击 worktree 会话行 → 自动切到该 worktree 的工作区标签页并恢复会话，会话在其真实目录上下文继续**；
4. worktree 内新建会话后主列表实时出现（sessions-index 订阅覆盖该 scope）；
5. 移除 worktree 后其会话行消失；「显示更多」分页、未读点、工作流脉冲计数在合并集上正确；
6. worktree 自己的工作区标签页列表保持自身 scope。

## 验证方式

`pnpm typecheck` / `pnpm lint` / 双包测试（新增纯函数单测：scope 合并与 worktree 判定放 `lib/` 下独立函数，文件 `packages/ui/test/workspaceTaskListsWorktreeMerge.test.ts`）/ `pnpm architecture:check --changed`；行为在 Web 端（skillpie.cn）手测——完成后执行 `./install_cli.sh` 重建宿主使 Web 会话生效。
