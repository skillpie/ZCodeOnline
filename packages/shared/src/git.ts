import type { Locale } from "./protocol.js";

export type GitHeadRefType = "branch" | "detached";

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed";

export type GitChangeSourceId = "unstaged" | "staged" | "branch" | "last-turn";

export type GitRepositoryChangeSourceId = Extract<
  GitChangeSourceId,
  "unstaged" | "staged" | "branch"
>;

export type GitChangeSectionId =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch"
  | "last-turn";

export type GitDiffAvailability = "patch" | "binary" | "truncated" | "unavailable";

export type GitBranchMutationAction = "switch" | "create-and-switch" | "delete";

export type GitBranchMutationIssueCode =
  | "invalid-branch-name"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "conflicts-present"
  | "operation-in-progress"
  | "branch-in-other-worktree"
  | "branch-in-main-worktree"
  | "branch-is-current"
  | "branch-not-fully-merged"
  | "unknown";

export interface GitRepositorySummary {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  /** Git 元数据 watcher 边界；workspace 内容 watcher 由 UI 按 workspace Host 平台决定。 */
  autoRefreshWatchPaths: GitRepositoryAutoRefreshWatchPath[];
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  isDirty: boolean;
  isGitAvailable: boolean;
  isRepository: boolean;
}

export interface GitRepositoryAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

export interface GitFileChange {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  x?: string;
  y?: string;
  kind: GitChangeKind;
  section: GitChangeSectionId;
  added: number;
  removed: number;
  isStaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
  /**
   * 是否存在可审查的文本差异。未跟踪的零行数条目（二进制文件、空文件、不可读产物）
   * 为 false：审阅面板不展示这类条目，但它们保留在变更列表中，
   * 供提交弹窗与「可提交」口径识别（isDirty 与提交内容保持一致）。
   */
  isReviewable: boolean;
}

export interface GitDiffRequest {
  path: string;
  staged?: boolean;
  sourceId?: GitChangeSourceId;
}

export interface GitDiffResult {
  path: string;
  availability: GitDiffAvailability;
  patch: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  summary?: string | null;
}

export interface GitIdentity {
  userName: string | null;
  userEmail: string | null;
  nameSource: string | null;
  emailSource: string | null;
  scopeLabel?: string | null;
}

export interface GitRepositoryRequest {
  workspacePath: string;
}

export type GitCommitGraphRefKind = "branch" | "remote" | "tag" | "head";

export interface GitCommitGraphRef {
  name: string;
  kind: GitCommitGraphRefKind;
}

export interface GitCommitGraphCommit {
  hash: string;
  parents: string[];
  refs: GitCommitGraphRef[];
  subject: string;
  authorName: string | null;
  authoredAtMs: number | null;
}

export interface GitCommitGraphRequest extends GitRepositoryRequest {
  maxCount?: number;
  skip?: number;
}

export interface GitCommitGraphResult {
  commits: GitCommitGraphCommit[];
  hasMore: boolean;
}

export interface GitRefreshRequest extends GitRepositoryRequest {
  includeIdentity?: boolean;
  includeBranchComparison?: boolean;
}

export type GitWorkspaceRepositoryKind = "not-repository" | "main-tree" | "linked-worktree";

export interface GitWorkspaceRepositoryInfo {
  workspacePath: string;
  kind: GitWorkspaceRepositoryKind;
  isGitAvailable: boolean;
}

export interface GitSwitchBranchRequest extends GitRepositoryRequest {
  targetBranchName: string;
}

export interface GitCreateBranchRequest extends GitRepositoryRequest {
  branchName: string;
  startPoint?: string;
}

export interface GitDeleteBranchRequest extends GitRepositoryRequest {
  branchName: string;
  /** true 时跳过“已合并”安全检查（git branch -D）；仅应在用户对未合并提交明确确认后使用。 */
  force?: boolean;
}

export interface GitWorktreeRecord {
  path: string;
  /** detached HEAD 的 worktree 没有分支名。 */
  branchName: string | null;
  head: string | null;
  isMain: boolean;
  /** path 与发起请求的 workspacePath 一致。 */
  isCurrentWorkspace: boolean;
}

export interface GitWorktreeListResult {
  /** 仅 linked worktree，按路径排序；主树不在列表中。 */
  worktrees: GitWorktreeRecord[];
  /** `.worktrees` 的锚点：即使当前 workspace 本身是 linked worktree，也指向主树根。 */
  mainTreeRoot: string;
  worktreeBaseDir: string;
}

export interface GitAddWorktreeRequest extends GitRepositoryRequest {
  /** 检出已有分支；与 newBranchName 互斥，同时提供时以 newBranchName 为准。 */
  branchName?: string;
  /** 基于当前 HEAD 新建分支并检出为 worktree。 */
  newBranchName?: string;
  /** 新分支的起点引用（分支名 / tag / commit）；缺省为当前 HEAD，仅 newBranchName 模式生效。 */
  newBranchStartPoint?: string;
  /**
   * 独立指定 worktree 目录名，与分支名解耦：目录名是本地标识，分支名进 MR。
   * 缺省时仍由分支名净化派生，保持旧行为。
   */
  directoryName?: string;
}

export type GitWorktreeMutationIssueCode =
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

export interface GitWorktreeMutationIssue {
  code: GitWorktreeMutationIssueCode;
  message: string;
  detail?: string | null;
}

export interface GitWorktreeMutationResult {
  ok: boolean;
  /** remove 成功时为 null。 */
  worktree: GitWorktreeRecord | null;
  issues: GitWorktreeMutationIssue[];
}

export interface GitRemoveWorktreeRequest extends GitRepositoryRequest {
  /** 必须出现在 `git worktree list` 输出中，拒绝删除任意输入路径。 */
  worktreePath: string;
}

export interface GitRenameWorktreeRequest extends GitRepositoryRequest {
  /** 必须出现在 `git worktree list` 输出中，拒绝重命名任意输入路径。 */
  worktreePath: string;
  /** 目标分支名；目录随之移动到主树 `.worktrees/<净化名>`，保持“目录名 = 净化分支名”约定。 */
  newBranchName: string;
}

export interface GitChangesRequest extends GitRepositoryRequest {
  sourceId: Extract<GitRepositoryChangeSourceId, "unstaged" | "staged">;
}

export interface GitIgnoredPathsRequest extends GitRepositoryRequest {
  paths: string[];
}

export interface GitDiffQuery extends GitRepositoryRequest, GitDiffRequest {}

export interface GitBlameQuery extends GitRepositoryRequest {
  path: string;
}

export interface GitBlameLine {
  /** 新文件中的行号（1 起） */
  line: number;
  /** 40 位提交哈希；未提交行为全 0 */
  hash: string;
  author: string;
  /** 作者提交时间（Unix 秒） */
  time: number;
}

export interface GitBlameResult {
  path: string;
  lines: GitBlameLine[];
}

export interface GitBranchComparison {
  baseRef: string | null;
  headRef: string | null;
  comparisonLabel: string | null;
  changes: GitFileChange[];
}

export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
  /**
   * 检出该分支的工作树绝对路径（主树或 linked worktree）。
   * 未被任何工作树检出、或 git 版本不支持 `%(worktreepath)` 时为 null。
   */
  worktreePath: string | null;
}

export interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
  /** 主树根；用于区分“被主树检出”与“被 linked worktree 检出”。无法解析时为 null。 */
  mainTreeRoot: string | null;
}

export interface GitBranchMutationIssue {
  code: GitBranchMutationIssueCode;
  message: string;
  paths?: string[];
  detail?: string | null;
}

export interface GitBranchMutationResult {
  ok: boolean;
  action: GitBranchMutationAction;
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  summary: GitRepositorySummary;
  issues: GitBranchMutationIssue[];
}

export interface GitPathMutationRequest extends GitRepositoryRequest {
  paths: string[];
}

export interface GitDiscardPathsRequest extends GitPathMutationRequest {
  staged?: boolean;
}

export interface GitCommitRequest extends GitRepositoryRequest {
  message: string;
  paths?: string[];
  stagedOnly?: boolean;
}

export interface GitCommitResult {
  commitHash: string;
  summary: GitRepositorySummary;
}

export interface GitGenerateCommitMessageRequest extends GitRepositoryRequest {
  workspaceIdentity?: string;
  locale?: Locale;
  includeUnstaged?: boolean;
  currentSessionFilePaths?: string[];
  conversationContext?: GitCommitMessageConversationContext;
}

export interface GitCommitMessageConversationContext {
  sessionId?: string;
  omittedMessageCount?: number;
  messages: GitCommitMessageConversationMessage[];
}

export interface GitCommitMessageConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GitGenerateCommitMessageResult {
  message: string;
  providerId: string;
  model: string;
}

export interface GitPushRequest extends GitRepositoryRequest {}

export type GitPushIntegrationKind = "fast-forward" | "rebase" | "merge";

/**
 * push 自动集成远端提交发生冲突的错误消息前缀。
 * 服务错误跨 MessagePort/rpc 只保留 message，UI 按此前缀识别冲突类失败，
 * 并提供「智能合并」入口把冲突处理转交当前对话的 Agent。
 */
export const GIT_PUSH_AUTO_INTEGRATION_CONFLICT_PREFIX = "git push auto integration failed:";

export interface GitPushIntegration {
  kind: GitPushIntegrationKind;
  /** 自动集成时远端领先的提交数。 */
  remoteCommitCount: number;
  /** 自动集成时本地领先的提交数（fast-forward 时为 0）。 */
  localCommitCount: number;
}

export interface GitPushResult {
  branchName: string | null;
  trackingBranchName: string | null;
  remoteName: string | null;
  setUpstream: boolean;
  summary: GitRepositorySummary;
  /** push 被拒后自动集成远端提交的结论；未发生集成时缺省。 */
  integration?: GitPushIntegration;
}

export interface GitPullResult {
  branchName: string | null;
  trackingBranchName: string | null;
  remoteName: string | null;
  summary: GitRepositorySummary;
}

export interface GitRefreshResult {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison | null;
}

export type GitCheckpointScope = "workspace";

export type GitCheckpointConflictReason =
  | "content-mismatch"
  | "missing-in-worktree"
  | "unexpected-file-in-worktree"
  | "type-mismatch";

export interface GitCheckpointMeta {
  checkpointId: string;
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  createdAt: number;
  refName: string;
  commitOid: string;
  scope: GitCheckpointScope;
}

export interface GitCheckpointRequest extends GitRepositoryRequest {
  checkpointId: string;
}

export interface GitCheckpointDiffQuery extends GitRepositoryRequest {
  fromCheckpointId: string;
  toCheckpointId: string;
}

export interface GitCheckpointFileDiff {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  originalPath?: string | null;
  kind: GitChangeKind;
  added: number;
  removed: number;
}

export interface GitCheckpointDiff {
  fromCheckpointId: string;
  toCheckpointId: string;
  files: GitCheckpointFileDiff[];
}

export interface GitCheckpointRestoreQuery extends GitCheckpointDiffQuery {
  force?: boolean;
}

export interface GitCheckpointConflict {
  path: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  reason: GitCheckpointConflictReason;
}

export interface GitCheckpointRestoreResult {
  success: boolean;
  conflicts?: GitCheckpointConflict[];
  restoredPaths?: string[];
}
