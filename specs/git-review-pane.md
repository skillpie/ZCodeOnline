# Spec: Git 审阅面板（来源切换 / 变更列表 / diff 懒加载）

> 实现入口：`packages/ui/src/GitPane.tsx`，装配于 `app-shell/AnimatedSidePanePanel`（workspace 侧边栏「审查」tab）。数据来源 `hooks/useGitRepository.ts`，状态装配在 `App.tsx`。

## 1. 产品规则

- 面板头部左侧是**变更来源分段切换（Segmented）**，共有三个来源（自左向右）：
  1. **未暂存**（`unstaged`）：工作区改动，含 unstaged / untracked / conflicted 分区。
  2. **已暂存**（`staged`）：暂存区改动。
  3. **已提交**（`branch`）：已提交、尚未推送到上游的文件，数据为 `git diff --numstat <upstream>...HEAD`（`IGitService.refresh` 的 `branchComparison`，仅 Git 面板打开时拉取）；展开文件查看 `upstream...HEAD` 的逐文件 diff（`IGitService.getDiff`，`sourceId: "branch"`）。来源只读，无 stage/discard 动作。
- 2026-09 产品决策：原下拉框中的「全部分支更改」更名为「已提交」并改为分段切换；「上一轮更改」（last-turn）来源移除——其数据集自 store 收尾后恒为空壳，不再出现在来源切换中。
- 头部右侧是「刷新」按钮（`onRefreshGit` 驱动 `refreshToken` 重拉真实 Git）；其右侧为「AI 评审」按钮（2026-09-27 新增）：点击把评审提示词发送到**当前工作区主对话**，**按当前选中来源评审对应类别**——未暂存（含未跟踪文件）/ 已暂存 / 已提交（当前分支领先上游的变更），由 AI 自行执行 git 命令查看差异并评审。发送能力复用 `lib/workspaceConversationPromptRuntime.ts`（owner 为主 pane SessionPane 的 `handleSendText`，链路与失败语义见 `specs/workspace-header-git-tools.md`），GitPane 不拼协议命令、不建第二条发送路径；无注册方（可用性 `unavailable`）时按钮不渲染。
- 变更列表按文件卡片渲染（虚拟滚动），点击展开懒加载该文件 diff（`IGitService.getDiff`，按 `sourceId:path` 缓存）；文件变更查找命中折叠文件时批量预加载 diff 并展开滚动到命中行。
- `readonly` 字段语义：`unstaged` / `staged` 为可写来源（恒 false），`branch`（已提交）为只读来源（恒 true）。

## 2. 状态所有者与不变量

- **来源选中态归 App**：`gitSelectedSourceId` + `taskSidePaneMemory`（按 workspace 身份记忆）。`GitPane` 不持有来源状态，只回抛 `onSelectSource`。
- `sourceOptions` / `datasets` 归 `useGitRepository` 所有，含 `unstaged` / `staged` / `branch` 三个来源；header 统计（`gitWorktreeChangeSummary`）与审阅入口 sourceId 推导（`gitWorktreeReviewSourceId`）复用同一份来源统计，不建第二条写路径。
- **历史内存兼容**：`taskSidePaneMemory` 中遗留的 `last-turn` 选中值不再命中 `sourceOptions`，按 App 既有 fallback 回落到第一个来源（未暂存），不做迁移清洗。
- 共享协议类型 `GitChangeSourceId`（含 last-turn）属于服务契约保留不动；UI 层不再生产 `last-turn` 值。

## 3. 失败语义

- git 不可用 / 非仓库 / 加载失败：列表区显示对应空态文案，分段切换仍可操作。
- 已提交来源：当前分支无上游（`trackingBranchName` 为空）或没有领先提交时，`branchComparison` 返回空列表，段内显示空态；不报错、不影响其他段。
- 单文件 diff 加载失败：卡片内显示不可用降级提示，不影响其他文件。
- 远端断连（workspaceRpc 未启用）：展示空壳面板，不发起远端 Git 查询。

## 4. 验收场景

1. 打开审查面板：头部为「未暂存 | 已暂存 | 已提交」分段控件，默认选中未暂存（无历史记忆时）；点击其他段切换列表并清空展开态。
2. 已提交未推送：提交后「已提交」段出现对应文件，`+N -N` 与展开 diff 基于 `<upstream>...HEAD`；推送清空后该段列表为空。
3. 刷新按钮：spinner 旋转，列表与统计更新。
4. 展开/折叠文件卡片：diff 懒加载一次，重复展开命中缓存。
5. 旧会话内存中选中过 last-turn：打开面板回落到未暂存，不报错、不显示空来源。
6. 查找（文件变更查找）：命中折叠文件时自动展开并滚动居中，跨文件循环。
7. AI 评审按钮：点击后当前对话收到评审提示词并开始执行，提示词针对**当前选中来源**对应类别的变更（草稿态则新建会话承载）；切换来源后再点击，评审范围随之变化；主 pane 未挂载时按钮不渲染；按钮不触发刷新、不改变来源选中态。
