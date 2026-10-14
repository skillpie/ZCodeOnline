# Spec: Git Worktree（并行工作树）

> 本功能为**附加式**新增：不引入新的持久化状态层，git 本身（`git worktree` 元数据）是唯一事实。
> **产品模型：worktree 是一个独立项目（workspace）**，不是分支维度的视图——它有自己的标签页、
> 会话、Review 面板，因此住在侧边栏项目列表里；分支切换器只负责“改变本树 HEAD”，不列 worktree。

## 1. 产品规则

- **创建**：分支切换器（`GitBranchSwitcher`）footer「新建 Worktree...」一键创建独立 worktree
  项目，命名与分支解耦：目录名 `{工程名}-{6位随机数}`（工程名取 workspace 目录名末段净化），
  分支名 `feat/{同6位随机数}`——共享后缀让「MR 分支 ↔ worktree 目录」双向可溯；分支名与已有
  分支撞名时自动重摇（最多 50 次，兜底秒级时间戳后缀）。解耦由服务端 `directoryName` 参数
  承载，可独立指定任意目录名（同一套净化与冲突校验）。基于当前 HEAD 创建，作为独立项目打开
  新标签页并回到新任务草稿；**不自动发送任何内容**，不代劳依赖安装（worktree 无
  `node_modules`）。这是分支切换器里唯一的 worktree 入口；分支行**不提供**“检出为 Worktree”。
- **管理**：worktree 以项目子项出现在侧边栏（路径含 `/.worktrees/` 即用 worktree 图标区分），
  重命名与删除都在侧边栏做。
  - 重命名：弹窗输入新分支名（预填当前分支名）。Host 侧先 `git branch -m` 重命名分支，再把
    目录 `git worktree move` 到主树 `.worktrees/<净化名>`；两步各自幂等，部分失败后重试可
    自愈。目标有运行中任务时 renderer 侧阻止；当前打开的 worktree 与 detached worktree 不提供
    重命名；成功后已打开标签页随路径迁移（`tabStore.migrateWorkspaceTabPath`）。
  - 删除：先取分支名，再 `git worktree remove` 目录与注册，最后删除分支。dirty（有未提交更改）
    **阻止**并提示，不提供 force；目标有运行中会话/任务先二次确认；目录已被外部清理的悬空
    记录自动 `git worktree prune`，注册表里已无此项则视为清理完成直接关闭项目条目。
- **分支切换器对 worktree 的唯一感知 = 占用标注**：分支列表来自 `git for-each-ref` 并携带
  `%(worktreepath)`，被任何工作树（主树或 linked worktree）检出的分支在行副标题显示其检出位置：

  ```text
  ● main                                （当前）
    feat/123456   已在 worktree「ZCodeOnline-123456」检出   → 点击：激活/打开该标签页
    feature/y                                               → 点击：切换 / hover 行尾动作
  ```

  - 被其它树占用的分支，点击行从“切换”改为**打开其所在工作树的标签页**（已打开则激活，否则
    `addTab` + `startDraft`）；在 worktree 标签页里看主树检出的 `main` 同理显示“在主树检出”、
    点击回到主树标签页。git 不允许一条分支同时被两个树检出，这个分叉把原本必失败的切换换成了
    用户真正需要的跳转；被占用行上不挂载 hover 动作（合入 / 拉取 / 删除）——删除挂在工作树
    上的分支本就会被 git 拒绝。
  - 老版本 git（< 2.23）不认识 `%(worktreepath)` atom：服务层识别 `unknown field name` 后
    去掉该字段重试，`worktreePath` 全部为 `null`，UI 退回无标注行为，不报错。

- worktree 目录统一落在**主树根**的 `.worktrees/<目录名>`；当前 workspace 本身已是 linked
  worktree 时同样锚定主树根（从 `git worktree list` 第一条解析），保证同一仓库的 worktree 聚在一处。
- 首次创建 worktree 时**幂等地**向主树 `.git/info/exclude` 追加一行 `.worktrees/`（repo 本地
  排除，不改用户的 `.gitignore`），避免主工作区 Review 面板与 `git status` 被嵌套目录污染。
- **删除分支**（分支切换器）：分支行 hover / focus 时行尾浮现「删除分支」（当前检出中的分支、
  被任意工作树占用的分支不提供）。点击后确认弹窗；默认安全删（`git branch -d`，仅删已合并
  分支），git 以 not-fully-merged 拒绝时二次确认“强制删除将丢提交”后携带 force（`-D`）重试。
- 不做：下拉里的 Worktrees 分组（与侧边栏形成重复的第二管理面）、分支行“检出为 Worktree”、
  独立的 worktree 管理面板、创建时自定义命名弹窗、基于任意 ref（非分支）的检出。

## 2. 状态所有者

```text
UI（GitBranchSwitcher 下拉 / 侧边栏项目项，投影缓存）
  │  仅通过 gitService RPC 读写；随下拉展开重新拉取，不持久化、不广播
  ▼
Host 端 IGitService → gitCliRepo（唯一所有者：命令执行 + porcelain 解析 + 错误翻译）
  ├─ git for-each-ref refs/heads … %(worktreepath)   → GitLocalBranch.worktreePath（占用标注）
  ├─ git worktree list --porcelain        → GitWorktreeRecord[]（第一条为主树）
  ├─ git worktree add <主树根>/.worktrees/<目录名> -b <branch>
  │    └─ 幂等写 .git/info/exclude: .worktrees/
  └─ git worktree remove <path>（目标必须在 list 输出中；dirty 报 worktree-dirty）
       └─ 目录丢失 → git worktree prune
git（worktree 元数据 + .worktrees/ 目录）
  └─ 唯一事实；终端里手工增删 worktree 后，下拉重新展开即回灌最新列表
```

- **单一事实**：worktree 注册表就是 git 自身的 worktree 元数据；UI store 仅做投影缓存，
  不落盘、不做第二事实（用户在终端增删后不会产生漂移）。
- **目录名生成**：服务端净化生成（`/` 等分隔符转 `-`，剥离 Git ref 非法字符与首尾
  `-.`），目录已存在时返回 `worktree-name-conflict`。`addWorktree` 的显式 `directoryName`
  与分支名解耦（footer 新建 Worktree 用其承载 `{工程名}-{6位随机}`）；缺省仍由分支名派生，
  保持并行副本「目录名 = 净化分支名」约定不变。
- **安全边界**：`removeWorktree` 的目标路径必须在 `git worktree list` 输出中，拒绝删除
  任意用户输入路径。

## 3. 接口（channel：`git`，复用现有 IGitService 描述符）

```ts
interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
  /** 检出该分支的工作树绝对路径（主树或 linked worktree）；未检出或老 git 不支持时为 null。 */
  worktreePath: string | null;
}

interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
  /** 主树根；renderer 用它把“被主树检出”与“被 linked worktree 检出”区分文案。未知时为 null。 */
  mainTreeRoot: string | null;
}

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
  /** 独立指定目录名，与分支名解耦；缺省仍由分支名净化派生 */
  directoryName?: string;
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
  deleteBranch(params: {
    workspacePath: string;
    branchName: string;
    force?: boolean;
  }): Promise<GitBranchMutationResult>; // action="delete"；安全删 -d，force 时 -D
}
```

- 服务通过既有 `ServiceRegistry.register(IGitService, gitService)` 注册（`packages/services/src/node.ts`），
  RPC 按方法名泛型分发，**不需要改 `zcode-protocol`**，桌面 / Web / 远程三端同构生效。

## 4. 事件顺序与失败语义

**创建（footer「新建 Worktree...」，项目副本语义）**

```text
footer 点击（renderer）
  → gitService.getLocalBranches 取现有分支名集合
  → buildWorktreeProjectName：目录 {工程名}-{6位随机}、分支 feat/{同随机}，分支撞名重摇
  → gitService.addWorktree({ newBranchName, directoryName })（基于当前 HEAD）
Host
  → resolveRepository（workspace 当前 git 上下文）
  → 校验新分支名（check-ref-format）+ 查重（branch-already-exists）
  → 解析主树根（worktree list 第一条）+ 净化 directoryName；已存在 → worktree-name-conflict
  → 幂等写 .git/info/exclude（追加缺失的 .worktrees/ 行）
  → git worktree add -b <新分支> <path>（git 原生拒绝翻译为 issue）
  → invalidate(workspacePath)（主树 status/exclude 缓存失效）
  → 返回 { ok, worktree }
renderer 收到成功
  → toast 成功 → tabStore.addTab(worktree.path) → sessionStore.startDraft(worktree.path)
```

- `.git/info/exclude` 写失败不阻塞创建（exclude 只是体验优化），记 warn 日志继续。
- `git worktree add` 失败时若本次追加过 exclude 且 worktree 未建成，不回滚（幂等行，无副作用）。

**分支列表的占用标注与跳转（分支切换器）**

```text
下拉展开（renderer）→ gitService.getLocalBranches
Host listLocalBranches
  → git for-each-ref refs/heads --format=…%00%(worktreepath)
      exitCode≠0 且 stderr 含 "unknown field name" → 去掉该字段重试（老 git 降级，worktreePath=null）
  → 每行解析 worktreePath（空串 → null）；返回 GitLocalBranchListResult.mainTreeRoot
    （worktree list 第一条；未知时 null）
renderer 分支行
  → occupiedElsewhere = worktreePath 非空 且 worktreePath ≠ 当前 workspacePath（realpath 不敏感：
    服务端已把 workspacePath 的 realpath 与原始形式都纳入“当前”判定，renderer 直接比对）
  → occupiedElsewhere：副标题「已在 worktree「<目录名>」检出」（worktreePath = mainTreeRoot 时
    文案为「在主树检出」）；点击 → tabStore.addTab(worktreePath) + startDraft；不挂 hover 动作
  → 否则：既有切换 / hover 动作行为
```

- 占用标注是只读投影，不新增命令；跳转复用“打开目录”的既有路径（addTab 命中已开 tab 即激活）。
- 分支名同时被两个树声称检出不可能发生（git 约束），renderer 不需要处理歧义。

**打开（侧边栏 worktree 项目项点击）**

```text
项目项点击 → 若 path 已有 tab：激活 → startDraft（回到空草稿，清 activeTaskId 语义与
useRootWorkspaceActions 打开目录一致）；否则 addTab + startDraft
```

**重命名（侧边栏 worktree 项目项「重命名」→ 弹窗输入新分支名）**

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

**删除（侧边栏 worktree 项目项「删除」→ 确认弹窗）**

```text
确认弹窗（useConfirmDialog）
  → renderer 侧防护：目标有运行中会话/任务 → 先二次确认
  → 先 listWorktrees 取分支名（目录还在时才能定位）
  → Host removeWorktree：worktreePath ∈ worktree list 校验 → 对目标 worktree 跑 status
      dirty → worktree-dirty issue，UI 展示，不提供 force
      干净 → git worktree remove；目录已丢 → git worktree prune
      注册表已无此项（worktree-not-found）→ renderer 视为清理完成，直接关闭项目条目
  → 成功后 deleteBranch 删除对应分支 → 关闭标签页、释放 workspace 运行时、失效任务缓存
```

## 5. 验收场景

1. footer「新建 Worktree...」→ 分支 `feat/<6位随机>` 与目录 `.worktrees/<工程名>-<同随机>` 生成、
   `.git/info/exclude` 出现 `.worktrees/`、主工作区 Review 面板不出现该目录、新标签页自动打开并
   停在空草稿，HEAD 与主树一致；侧边栏出现带 worktree 图标的项目子项。
2. 重复点击多次 → 各自产出不同随机后缀的独立项目，可共存；分支名撞车自动重摇。
3. 基于当前 workspace 为 linked worktree 的仓库执行创建 → 新 worktree 仍落在主树 `.worktrees/` 下。
4. **占用标注**：主树分支切换器里 `feat/<随机>` 行显示「已在 worktree「<目录名>」检出」，点击
   激活/打开该标签页而非报“分支被其它 worktree 占用”；hover 不出现合入 / 删除动作。在 worktree
   标签页里 `main` 行显示「在主树检出」，点击回到主树标签页。被占用标注不影响普通分支的切换。
5. 老版本 git（不认识 `%(worktreepath)`）：分支列表照常加载，无占用标注，无报错。
6. 重命名：侧边栏「重命名」→ 输入新分支名 → 分支与目录同步更新（HEAD 与未提交更改不变）、
   已打开标签页迁移到新路径；重名分支 / 目录被占 / 非法名分别命中对应 issue；当前 workspace
   与 detached 子项不提供重命名入口。
7. 删除 clean worktree：确认后目录、git 注册与分支消失、项目条目关闭；删除 dirty worktree：
   被阻止并提示未提交更改；目标会话运行中：先二次确认；手动删目录后的悬空记录：自动 prune /
   注册表已空时直接关闭条目。
8. 删除分支（分支切换器）：hover 分支行行尾出现删除图标（当前分支与被占用分支无此入口）；
   已合并分支确认后删除并从列表消失；未合并分支首次被拒 → 二次确认强制删除后才删除。
9. 终端手工 `git worktree add/remove` 后重新展开下拉 → 占用标注反映最新事实（无第二事实漂移）。
10. Web 与桌面行为一致（同一 gitService 通道）；服务层单测覆盖 porcelain 解析、目录名净化、
    `directoryName` 解耦、`worktreepath` 解析与老 git 降级、重命名、删除分支（安全删 / 未合并
    拒绝 / force）、创建/移除的 issue 翻译。

## 6. 边界与不变量

- 不改 `zcode-protocol`；不动 agent 运行时（worktree 会话 cwd=workspacePath，既有机制直接生效）。
- `workspaceIdentity` 隔离免费获得：worktree 标签页 identity key 独立，会话、草稿、数据源记忆
  互不串扰（`tabWorkspaceIdentity` 现有逻辑）。
- worktree 列表、分支列表均「展开即拉取」，不引入跨窗口广播；不把 UI 投影当服务端事实。
- 图形特征（feature graph）：新增 `git-worktree` 边界节点，挂在既有 git 分支切换边界之下。
