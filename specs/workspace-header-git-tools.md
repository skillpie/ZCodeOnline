# Spec: 工作区头部 Git 工具（更改 / 提交 / 拉取 / 分支）

> 实现入口：`packages/ui/src/WorkspaceHeaderGitTools.tsx`，装配于 `WorkspaceHeaderActionSection`（窗口右上角，分享按钮左侧）。
> 本功能自 v4 状态面板的「Git 工具」分区迁移而来：面板展开态不再有 Git 分区；收起态 mini 胶囊上的 git 统计（`StatusSummaryRow`）保持不变。草稿态输入框上方项目名右侧的分支切换器（`draftComposerHeader`）曾按当时决策与头部入口并存；**2026-09-28 按用户决策移除**：草稿态 contextHeader 不再渲染分支切换器，分支操作统一收敛到右上角头部入口，`draftComposerHeader` 插槽本身保留（仍承载 workspace 切换菜单与插件入口）。

## 1. 产品规则

- 窗口右上角头部、分享按钮左侧，常驻 Git 操作（按此顺序排列），任务态与草稿态一致（均为 workspace 作用域能力）：
  1. ~~**更改**：diff 图标 + `+N -N` 行数统计~~（**2026-09-26 按用户决策移除**：恢复为最初无此按钮的形态，「更改 +N -N」不再出现在头部。同日后续决策：更改展示以**浮动状态面板「环境」分区**的形式恢复——仅「更改」行（FileDiffIcon + `+N -N`，点击进 Git 审阅），分支切换与提交菜单不回归、仍留在头部；见 `ConversationStatusPanel` 的 `GitChangesStatusSection`。组件 props 链按新形态重建，App 侧 `gitWorktreeReviewSourceId` / `onOpenGitReview` 链路改为服务状态面板。）
  2. **提交**：`GitActionMenu` 默认头部布局触发器，按既有主动作裁决打开提交弹窗或推送弹窗。在 `isDirty || canPushGitBranch(gitSummary)` 时展示——已提交未推送（领先上游或尚无上游的新分支）时仍展示，点击经主动作裁决直接进推送弹窗，触发器的图标与文案随之切为「推送」（`git.actionMenu.push`）。
  3. **拉取**：提交槽位的兜底项。工作区干净且无待推送（`!isDirty && !canPushGitBranch`）且有上游分支时，同一位置显示「拉取」按钮（`ArrowDownToLine` 图标）；点击调用 `IGitService.pull`（`git pull --ff-only`），成功 toast「已拉取远程更新」并 `onRefreshGit`，失败 toast 原始错误，进行中按钮转 spinner 并禁用。**快进式是有意约束**：分叉时直接报错让用户手动处理，不在 agent 工作区里悄悄生成 merge commit 或进入冲突态。detached HEAD / 无上游不展示。
  4. **分支选择**：`GitBranchSwitcher` 紧凑触发器（图标 + 分支名，超长截断），弹层向下弹出，能力与页头分支切换器一致（搜索、新建分支、提交图表）。**唯一常驻项**。当前分支行不打勾（2026-09-27 用户决策，移除行尾 ✓），以选中底色（`bg-selected`）和分支名加粗（`font-semibold`）标识，行内不再渲染 CheckIcon。
  - **排序（2026-09-26 按用户决策）**：分支切换器渲染在最左，「提交/拉取」槽位移到其右。
  - **分支弹窗对话动作「合入 / 拉取」（2026-09-27 新增，仅头部弹窗启用）**：分支行交互时按需**挂载**行尾动作按钮——hover 或 focus-within 时渲染，触屏（`hover:none`）常驻；未交互时不渲染、不占行内布局（同 `workspace-grouped-tasks/task-row` 的挂载式决策，不用 CSS 隐藏）。点击不切换分支，而是关闭弹层并把提示词发送到**当前工作区主对话**，由 AI 执行：
    - 非当前分支行显示「合入」（按钮文案 2026-09-27 由「合并」改为「合入」），提示词为「将分支 {branchName} 合并到本地当前分支，遇冲突解决后完成合并」，由 AI 执行合并（含冲突处理）。
    - 当前分支行显示「拉取」，提示词为「拉取当前分支（{branchName}）的远程更新」，由 AI 执行；**与头部直连「拉取」（快进式、分叉即报错）语义不同**：弹窗内拉取由 AI 决策分叉处理（如 rebase/merge），两者互不替代。按钮 hover 显示在行尾。
  - 提交弹窗（`GitActionMenu`）不启用对话动作，维持原能力集。（草稿区分支弹窗已随 2026-09-28 的移除决策不复存在。）
- **展示规则（提交/拉取互斥占同一槽位）**：「提交」跟随 `isDirty || canPushGitBranch`；两者都不满足时该槽位显示「拉取」。agent 改文件后随 `onRefreshGit` 重新出现。
- 非 Git 工作区（git 不可用或不是仓库）整组不渲染；远程移动端窄头部（`simplifyForNarrowRemote`）整组隐藏，与终端入口同一折叠规则。工作区头部的可见性由壳层唯一谓词 `shouldRenderWorkspaceHeader`（`app-shell/workspaceHeaderVisibility.ts`）裁决：主视图为 `chat` 即渲染，不再区分平台与任务/草稿态——**2026-09-27 按用户决策，Web 端（含手机远控）草稿态对齐桌面，渲染头部**，Git 工具随之常驻可见；草稿态头部没有分享按钮（依赖活动任务）。头部只消费壳层投影的 chrome 状态（git 摘要、终端/侧栏开关），不承载流式/快照语义，草稿态渲染头部不触碰 web-remote-replayable 恢复链路。
- 标题区既有 hover 提示中的分支名（`WorkspaceHeaderTitleSection`）保持不变，仅作信息展示。

## 2. 状态所有者与不变量

- 组件不持有 Git 状态：`gitSummary`、`gitDirtyFileCount`、`activeTaskChangeSummary` 全部由 `WorkspaceShellLayout` 从 shell 投影下发，变更由 `onRefreshGit` 驱动刷新。
- 提交 / 推送弹窗、分支弹层的交互状态仍归 `GitActionMenu` / `GitBranchSwitcher` 内部所有；头部只提供触发器，不复制状态、不建第二条写路径。
- 渲染门（两级）：`WorkspaceHeaderActionSection` 按 `gitSummary && onRefreshGit` 开门；`WorkspaceHeaderGitTools` 内再按 `isGitAvailable && isRepository` 裁决。
- **「合并 / 拉取」提示词链路（2026-09-27）**：发送编排的唯一 owner 是主 pane 的 `SessionPane`（`paneId === "workspace-main"` 且非 `readOnly`），它把既有 `handleSendText`（含 configCommandBarrier、草稿首发建会话、CommandInbox admission）注册进 `lib/workspaceConversationPromptRuntime.ts` 的模块级路由表（key = `workspaceIdentity?.trim() || workspacePath`，与 selectionSideChatRuntime 同模式）；头部分支弹窗位于会话 Provider 外，只按同一 key 请求路由（`requestWorkspaceConversationPrompt`），不拼协议命令、不建第二条发送路径。busy/running 会话的输入准入仍归 CLI runtime `CommandInbox` 串行处理，UI 不额外排队。无注册方（可用性 `unavailable`）时不渲染按钮，不做点击后失败兜底。

## 3. 失败语义

- `gitSummary` 缺失 / git 不可用 / 非仓库 / 缺 `onRefreshGit`：整组不渲染（不挂 disabled 占位）。
- 仓库干净且无待推送：提交槽位显示「拉取」；无上游 / detached HEAD 时不显示拉取。
- 拉取失败（网络、分叉不可快进、无权限等）：toast 透传原始错误，按钮恢复可用，不改工作区状态。
- 缺 `onOpenGitReview`：更改入口禁用，统计数字保留为只读信息。
- `canUseGitActionMenu` 为假（探测失败等，但仍有脏文件）：提交触发器置灰不隐藏（既有产品决策，日志照常输出）。
- 「合入」发送失败（provider 未就绪、admission 拒绝等）：错误由主 pane 既有 pane-local 错误横幅呈现（`handleSendText` 内部收口），分支弹窗不重复 toast；发送结果为 `blocked`（如模型未就绪、确认态）时同样由主对话既有交互承接。

## 4. 验收场景

1. git 仓库有未提交内容的任务态与草稿态：头部分享按钮左侧同时可见 `+N -N`、提交、分支名；点击分别打开审阅、提交弹窗、分支弹层（向下）。
2. agent 修改文件后：统计数字随 `onRefreshGit` 更新；提交完成后「更改」隐藏。
3. 已提交未推送（ahead > 0 或尚无上游）：「更改」隐藏，「提交」保留（显示为推送），点击直接打开推送弹窗。
4. 干净且与上游同步 / 落后：提交槽位显示「拉取」；点击后转 spinner，成功 toast 并刷新 ahead/behind；远程有新提交时被拉到本地。
5. 非 Git 目录：头部无 Git 入口，其余头部按钮不受影响。
6. 头部宽度收窄：统计文案与提交文案依次收起为图标，不与分享、帮助、终端按钮挤行。
7. 分支行对话动作：hover 非当前分支行出现「合入」，点击后弹层关闭、当前对话收到合并提示词并开始执行（草稿态则新建会话承载）；hover 当前行出现「拉取」，点击发送拉取提示词由 AI 同步远程；点击任一按钮都不触发分支切换；主 pane 未挂载（可用性 unavailable）时按钮不渲染。
8. Web 端（非桌面）新建任务（草稿态）：右上角头部与桌面一致渲染——分支切换器常驻、提交/拉取按仓库状态占位，帮助 / 终端 / 侧栏开关可用，无分享按钮；发送首条消息进入任务态后头部内容保持不变。
