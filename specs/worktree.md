# Spec: Git Worktree（并行工作树）

> 本功能为**附加式**新增：不引入新的持久化状态层，git 本身（`git worktree` 元数据）是唯一事实；
> UI 入口挂在现有分支切换器上，worktree 目录创建后作为普通本地 workspace 打开新标签页。

## 1. 产品规则

- 分支切换器（`GitBranchSwitcher`）下拉以**树形二级菜单**展示 worktree：worktree 按其检出的
  分支归组，嵌在该分支行下方；有 worktree 的分支行首提供展开箭头，**默认折叠**；worktree
  子项单行展示（目录名 + 行尾 hover 的「重命名 / 移除」），点击行在本窗口打开新 workspace
  标签页并回到新任务草稿。detached / 分支已删除等无主 worktree 落到兜底「Worktrees」分组。
- **所有分支行**（含当前分支）的行尾提供「检出为 Worktree」动作（hover / focus-within 挂载，
  触屏常驻，与行尾对话动作同模式），统一为**并行副本语义**：每次点击都基于该分支新建
  `{源分支名}-{MMddHHmm}` 分支并检出为独立 worktree，不动当前工作区、不携带未提交更改。
  git 不允许同一分支检出两个 worktree，副本命名天然规避该限制，因此重复点击、对当前分支
  点击都能持续产出并行副本；默认名与现有分支撞车时降级为秒级 `{...}-{MMddHHmmss}`，仍撞车
  追加 `-2`、`-3` 序号。无弹窗、无底部独立入口（行尾的「合入 / 拉取」是既有对话动作，与
  worktree 无关）。
- 创建副本成功后，把来源分支写入 repo 本地 config `branch.<副本>.worktreeSource`（与 git 自身
  存 upstream 元数据同一模式；`git branch -m` 会自动迁移该键）。树形分组据此把副本挂到来源
  分支行下，顶层不再重复展示副本分支行；无记录（旧数据）或来源分支已删除时回退挂在副本自身
  分支行下，detached 落到兜底「Worktrees」分组。
- worktree 目录统一落在**主树根**的 `.worktrees/<净化后的分支名>`；当前 workspace 本身已是
  linked worktree 时同样锚定主树根（从 `git worktree list` 第一条解析），保证同一仓库的所有
  worktree 聚在一处。
- 首次创建 worktree 时**幂等地**向主树 `.git/info/exclude` 追加一行 `.worktrees/`（repo 本地
  排除，不改用户的 `.gitignore`），避免主工作区 Review 面板与 `git status` 被嵌套目录污染。
- 创建成功后：打开新 workspace 标签页（`addTab`）并启动空的新任务草稿（`startDraft`），
  **不自动发送任何内容**；不代劳依赖安装（worktree 无 `node_modules`，需要用户自行 bootstrap）。
- 重命名：worktree 子项行尾「重命名」→ 弹窗输入新分支名（预填当前分支名）。Host 侧先
  `git branch -m` 重命名分支，再把目录 `git worktree move` 到主树 `.worktrees/<净化名>`，
  保持“目录名 = 净化分支名”约定；两步各自幂等，部分失败后重试可自愈。目标 workspace 有
  运行中任务时 renderer 侧阻止；当前 workspace（正打开的 worktree）与 detached worktree 不提供
  重命名；重命名成功后已打开的本地标签页随路径迁移（`tabStore.migrateWorkspaceTabPath`）。
- 移除：clean worktree 经确认后 `git worktree remove`；dirty（有未提交更改）**阻止**并提示，
  不提供 force；目标 workspace 有运行中会话/任务时由 renderer 侧阻止；目录已被外部删除的
  悬空记录在移除时自动 `git worktree prune`。主树不提供移除。
- 不做：独立的 worktree 管理面板、创建时自定义命名的弹窗、基于任意 ref（非分支）的检出。

## 2. 状态所有者

```text
UI（GitBranchSwitcher 下拉，投影缓存）
  │  仅通过 gitService RPC 读写；随下拉展开重新拉取，不持久化、不广播
  ▼
Host 端 IGitService → gitCliRepo（唯一所有者：命令执行 + porcelain 解析 + 错误翻译）
  ├─ git worktree list --porcelain        → GitWorktreeRecord[]（第一条为主树）
  ├─ git worktree add <主树根>/.worktrees/<name> [-b <branch> | <branch>]
  │    └─ 幂等写 .git/info/exclude: .worktrees/
  └─ git worktree remove <path>（目标必须在 list 输出中；dirty 报 worktree-dirty）
       └─ 目录丢失 → git worktree prune
git（worktree 元数据 + .worktrees/ 目录）
  └─ 唯一事实；终端里手工增删 worktree 后，下拉重新展开即回灌最新列表
```

- **单一事实**：worktree 注册表就是 git 自身的 worktree 元数据；UI store 仅做投影缓存，
  不落盘、不做第二事实（用户在终端增删后不会产生漂移）。
- **目录名生成**：服务端从分支名净化生成（`/` 等分隔符转 `-`，剥离 Git ref 非法字符与首尾
  `-.`），目录已存在时返回 `worktree-name-conflict`，v1 不提供改名 UI。
- **安全边界**：`removeWorktree` 的目标路径必须在 `git worktree list` 输出中，拒绝删除
  任意用户输入路径。

## 3. 接口（channel：`git`，复用现有 IGitService 描述符）

```ts
interface GitWorktreeRecord {
  path: string;
  /** detached HEAD 时为 null */
  branchName: string | null;
  head: string | null;
  isMain: boolean;
  /** path 与发起请求的 workspacePath 一致 */
  isCurrentWorkspace: boolean;
}

interface GitWorktreeListResult {
  worktrees: GitWorktreeRecord[]; // 仅 linked worktree，按路径名排序
  mainTreeRoot: string; // .worktrees 锚点
  worktreeBaseDir: string; // <mainTreeRoot>/.worktrees
}

interface GitAddWorktreeRequest extends GitRepositoryRequest {
  /** 检出已有分支；与 newBranchName 互斥 */
  branchName?: string;
  /** 新建分支并检出为 worktree */
  newBranchName?: string;
  /** 新分支的起点引用（分支 / tag / commit）；缺省为当前 HEAD，仅 newBranchName 模式生效 */
  newBranchStartPoint?: string;
}

interface GitWorktreeMutationIssue {
  code:
    | "invalid-branch-name"
    | "branch-already-exists"
    | "branch-not-found"
    | "branch-in-other-worktree"
    | "invalid-worktree-name"
    | "worktree-name-conflict"
    | "worktree-dirty"
    | "worktree-not-found"
    | "worktree-detached"
    | "operation-in-progress"
    | "not-repository"
    | "unknown";
  message: string;
  detail?: string | null;
}

interface GitWorktreeMutationResult {
  ok: boolean;
  worktree: GitWorktreeRecord | null; // remove 成功时为 null
  issues: GitWorktreeMutationIssue[];
}

interface IGitService {
  listWorktrees(params: GitRepositoryRequest): Promise<GitWorktreeListResult>;
  addWorktree(params: GitAddWorktreeRequest): Promise<GitWorktreeMutationResult>;
  removeWorktree(params: {
    workspacePath: string;
    worktreePath: string;
  }): Promise<GitWorktreeMutationResult>;
  renameWorktree(params: {
    workspacePath: string;
    worktreePath: string;
    newBranchName: string;
  }): Promise<GitWorktreeMutationResult>;
}
```

- 服务通过既有 `ServiceRegistry.register(IGitService, gitService)` 注册（`packages/services/src/node.ts`），
  RPC 按方法名泛型分发，**不需要改 `zcode-protocol`**，桌面 / Web / 远程三端同构生效。

## 4. 事件顺序与失败语义

**创建（分支行「检出为 Worktree」，统一并行副本语义）**

```text
行尾动作点击（renderer）
  → 生成默认名 buildWorktreeBranchSuggestion：{源分支名}-{MMddHHmm}，
    与本地分支投影撞车时降级 {..}-{MMddHHmmss}、{..}-{MMddHHmmss}-{n}
  → gitService.addWorktree({ newBranchName, newBranchStartPoint: 来源分支 })
Host
  → resolveRepository（workspace 当前 git 上下文）
  → 校验新分支名（check-ref-format）+ 查重（branch-already-exists）
  → 校验起点引用存在（rev-parse --verify --end-of-options；失败 → branch-not-found）
  → 解析主树根（worktree list 第一条）+ 生成净化目录名；已存在 → worktree-name-conflict
  → 幂等写 .git/info/exclude（追加缺失的 .worktrees/ 行）
  → git worktree add -b <新分支> <path> -- <起点>（git 原生拒绝翻译为 issue）
  → invalidate(workspacePath)（主树 status/exclude 缓存失效）
  → 起点为本地分支时写 branch.<副本>.worktreeSource = 起点（失败只 warn，不阻塞）
  → 返回 { ok, worktree }
renderer 收到成功
  → toast 成功 → tabStore.addTab(worktree.path) → sessionStore.startDraft(worktree.path)
```

- `.git/info/exclude` 写失败不阻塞创建（exclude 只是体验优化），记 warn 日志继续。
- `git worktree add` 失败时若本次追加过 exclude 且 worktree 未建成，不回滚（幂等行，无副作用）。

**打开（worktree 子项或兜底分组行点击）**

```text
行点击 → 若 path 已有 tab：激活 → startDraft（回到空草稿，清 activeTaskId 语义与
useRootWorkspaceActions 打开目录一致）；否则 addTab + startDraft
```

**重命名（worktree 子项行尾「重命名」→ 弹窗输入新分支名）**

```text
确认（renderer）
  → 防护：目标 worktree 是当前 workspace / detached / 存在运行中任务 → 阻止（入口隐藏或 toast）
  → Host renameWorktree：
      worktreePath ∈ worktree list 校验（挡住主树与任意路径；失败 → worktree-not-found）
      detached → worktree-detached
      校验新分支名（check-ref-format → invalid-branch-name；已存在 → branch-already-exists）
      步骤一：git branch -m <旧> <新>（已是目标名则跳过 → 幂等）
      步骤二：净化目录名 → 与当前路径相同则跳过；
              .worktrees/<净化名> 被占 → worktree-name-conflict；
              否则 git worktree move <旧路径> <新路径>
      invalidate(workspacePath) → 重拉列表返回最新 worktree 记录
renderer 收到成功
  → toast 成功 → tabStore.migrateWorkspaceTabPath(旧路径, 新路径) → 重拉 worktree 投影
```

- 两步各自幂等：分支已重命名而目录未移动的中间态，重试会跳过步骤一直接完成步骤二（自愈）。
- 会话/任务历史仍按旧 workspace 路径键保留，不随重命名迁移；运行中任务已被 renderer 阻护。

**移除（行尾「移除」→ 确认弹窗）**

```text
确认弹窗（useConfirmDialog）
  → renderer 侧防护：目标 worktree 路径存在运行中会话/任务 → toast 阻止，不发请求
  → Host：worktreePath ∈ worktree list 校验 → 对目标 worktree 跑 status
      dirty → worktree-dirty issue，UI 展示，不提供 force
      干净 → git worktree remove；目录已丢（isMissingWorkingDirectoryResult）→ git worktree prune
  → invalidate(workspacePath) → 返回
```

- 移除不删除分支本身；分支回到「未检出」状态后可再次被普通切换或重新检出为 worktree。

## 5. 验收场景

1. 选任意分支 → 行尾「检出为 Worktree」→ 新分支 `{源分支名}-{MMddHHmm}` 生成并检出为
   `.worktrees/<净化名>`、`.git/info/exclude` 出现 `.worktrees/`、主工作区 Review 面板不出现
   该目录、新标签页自动打开并停在空草稿，且 HEAD 与来源分支一致。
2. 对同一分支再次点击、以及对当前分支（如 main）点击 → 各自创建 `{源分支名}-{MMddHHmm}` 并行
   副本；同一分钟内重复创建时自动降级秒级后缀，多副本可共存。
3. 基于当前 workspace 为 linked worktree 的仓库执行创建 → 新 worktree 仍落在主树 `.worktrees/` 下。
4. 树形二级菜单：副本挂在**来源分支**行下（如在 linchuncheng 上创建的两个副本都折叠在
   linchuncheng 行内），副本分支行不再在顶层重复出现；行首折叠箭头默认折叠，子项单行缩进；
   点击子项打开对应标签页；当前 workspace 子项显示「当前」标识；无主 worktree 落到兜底
   「Worktrees」分组。
5. 重命名：子项行尾「重命名」→ 输入新分支名 → 分支与目录同步更新（HEAD 与未提交更改不变）、
   已打开标签页迁移到新路径；重名分支 / 目录被占 / 非法名分别命中对应 issue；当前 workspace
   与 detached 子项不提供重命名入口。
6. 移除 clean worktree：确认后目录与 git 记录消失；移除 dirty worktree：被阻止并提示未提交更改；
   目标 workspace 会话运行中：renderer 阻止；手动删目录后的悬空记录：移除动作自动 prune。
7. 终端手工 `git worktree add/remove` 后重新展开下拉 → 列表反映最新事实（无第二事实漂移）。
8. Web 与桌面行为一致（同一 gitService 通道）；服务层单测覆盖 porcelain 解析、目录名净化、
   startPoint 并行副本、重命名、创建/移除的 issue 翻译。

## 6. 边界与不变量

- 不改 `zcode-protocol`；不动 agent 运行时（worktree 会话 cwd=workspacePath，既有机制直接生效）。
- `workspaceIdentity` 隔离免费获得：worktree 标签页 identity key 独立，会话、草稿、数据源记忆
  互不串扰（`tabWorkspaceIdentity` 现有逻辑）。
- worktree 列表、分支列表均「展开即拉取」，不引入跨窗口广播；不把 UI 投影当服务端事实。
- 图形特征（feature graph）：新增 `git-worktree` 边界节点，挂在既有 git 分支切换边界之下。
