# Spec: 工作区头部 Git 工具（更改 / 提交 / 拉取 / 分支）

> 实现入口：`packages/ui/src/WorkspaceHeaderGitTools.tsx`，装配于 `WorkspaceHeaderActionSection`（窗口右上角，分享按钮左侧）。
> 本功能自 v4 状态面板的「Git 工具」分区迁移而来：面板展开态不再有 Git 分区；收起态 mini 胶囊上的 git 统计（`StatusSummaryRow`）保持不变。草稿态输入框上方项目名右侧的分支切换器（`draftComposerHeader`）按用户要求保留，与头部入口并存：头部是任务/草稿通用的常驻入口，草稿 contextHeader 只保留分支这一项。

## 1. 产品规则

- 窗口右上角头部、分享按钮左侧，常驻 Git 操作（按此顺序排列），任务态与草稿态一致（均为 workspace 作用域能力）：
  1. **更改**：diff 图标 + `+N -N` 行数统计（来源 `gitWorktreeChangeSummary`），点击打开 Git 审阅（`onOpenGitReview`，携带 worktree review sourceId）。仅在有 待提交内容（`gitSummary.isDirty`）时展示；头部变窄（<560px 容器）时收起统计文字只留图标。
  2. **提交**：`GitActionMenu` 默认头部布局触发器，按既有主动作裁决打开提交弹窗或推送弹窗。在 `isDirty || canPushGitBranch(gitSummary)` 时展示——已提交未推送（领先上游或尚无上游的新分支）时仍展示，点击经主动作裁决直接进推送弹窗，触发器的图标与文案随之切为「推送」（`git.actionMenu.push`）。
  3. **拉取**：提交槽位的兜底项。工作区干净且无待推送（`!isDirty && !canPushGitBranch`）且有上游分支时，同一位置显示「拉取」按钮（`ArrowDownToLine` 图标）；点击调用 `IGitService.pull`（`git pull --ff-only`），成功 toast「已拉取远程更新」并 `onRefreshGit`，失败 toast 原始错误，进行中按钮转 spinner 并禁用。**快进式是有意约束**：分叉时直接报错让用户手动处理，不在 agent 工作区里悄悄生成 merge commit 或进入冲突态。detached HEAD / 无上游不展示。
  4. **分支选择**：`GitBranchSwitcher` 紧凑触发器（图标 + 分支名，超长截断），弹层向下弹出，能力与页头分支切换器一致（搜索、新建分支、提交图表）。**唯一常驻项**。
- **展示规则（提交/拉取互斥占同一槽位）**：「更改」跟随 `isDirty`；「提交」跟随 `isDirty || canPushGitBranch`；两者都不满足时该槽位显示「拉取」。agent 改文件后随 `onRefreshGit` 重新出现。
- 非 Git 工作区（git 不可用或不是仓库）整组不渲染；远程移动端窄头部（`simplifyForNarrowRemote`）整组隐藏，与终端入口同一折叠规则。Web 端草稿态按壳层既有规则不渲染工作区头部，Git 工具随之不可见（与旧草稿态分支入口仅桌面可见的行为一致）。
- 标题区既有 hover 提示中的分支名（`WorkspaceHeaderTitleSection`）保持不变，仅作信息展示。

## 2. 状态所有者与不变量

- 组件不持有 Git 状态：`gitSummary`、`gitDirtyFileCount`、`gitWorktreeChangeSummary`、`activeTaskChangeSummary` 全部由 `WorkspaceShellLayout` 从 shell 投影下发，变更由 `onRefreshGit` 驱动刷新。
- 提交 / 推送弹窗、分支弹层的交互状态仍归 `GitActionMenu` / `GitBranchSwitcher` 内部所有；头部只提供触发器，不复制状态、不建第二条写路径。
- 渲染门（两级）：`WorkspaceHeaderActionSection` 按 `gitSummary && onRefreshGit` 开门；`WorkspaceHeaderGitTools` 内再按 `isGitAvailable && isRepository` 裁决。

## 3. 失败语义

- `gitSummary` 缺失 / git 不可用 / 非仓库 / 缺 `onRefreshGit`：整组不渲染（不挂 disabled 占位）。
- 仓库干净且无待推送：提交槽位显示「拉取」；无上游 / detached HEAD 时不显示拉取。
- 拉取失败（网络、分叉不可快进、无权限等）：toast 透传原始错误，按钮恢复可用，不改工作区状态。
- 缺 `onOpenGitReview`：更改入口禁用，统计数字保留为只读信息。
- `canUseGitActionMenu` 为假（探测失败等，但仍有脏文件）：提交触发器置灰不隐藏（既有产品决策，日志照常输出）。

## 4. 验收场景

1. git 仓库有未提交内容的任务态与草稿态：头部分享按钮左侧同时可见 `+N -N`、提交、分支名；点击分别打开审阅、提交弹窗、分支弹层（向下）。
2. agent 修改文件后：统计数字随 `onRefreshGit` 更新；提交完成后「更改」隐藏。
3. 已提交未推送（ahead > 0 或尚无上游）：「更改」隐藏，「提交」保留（显示为推送），点击直接打开推送弹窗。
4. 干净且与上游同步 / 落后：提交槽位显示「拉取」；点击后转 spinner，成功 toast 并刷新 ahead/behind；远程有新提交时被拉到本地。
5. 非 Git 目录：头部无 Git 入口，其余头部按钮不受影响。
6. 头部宽度收窄：统计文案与提交文案依次收起为图标，不与分享、帮助、终端按钮挤行。
