type WorkspaceConversationPromptSender = (text: string) => Promise<unknown>;

export interface WorkspaceConversationPromptScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface WorkspaceConversationPromptSenderEntry {
  focused: boolean;
  send: WorkspaceConversationPromptSender;
}

const senders = new Map<string, Map<symbol, WorkspaceConversationPromptSenderEntry>>();
const listeners = new Set<() => void>();

function getWorkspaceKey(path: string, identity?: string): string {
  return identity?.trim() || path;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function getSenderEntry(workspaceKey: string): WorkspaceConversationPromptSenderEntry | undefined {
  const scoped = senders.get(workspaceKey);
  if (!scoped?.size) return undefined;
  const candidates = Array.from(scoped.values());
  return candidates.find((candidate) => candidate.focused) ?? candidates[0];
}

/**
 * 头部 Git 工具（分支弹窗「合并」）位于会话 Provider 外，不能自己拼协议命令；
 * 由已挂载的主 pane SessionPane 注册其既有的 handleSendText 编排能力（含
 * configCommandBarrier、草稿首发建会话与 CommandInbox admission），外部只按
 * workspace 身份 key 路由请求。同一 workspace 出现多个注册方时优先 focused，
 * 保持命令 owner 与当前输入焦点一致。与 selectionSideChatRuntime 同模式。
 */
export function registerWorkspaceConversationPromptSender(
  scope: WorkspaceConversationPromptScope,
  send: WorkspaceConversationPromptSender,
  focused: boolean,
): () => void {
  const workspaceKey = getWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
  const token = Symbol(workspaceKey);
  const scoped =
    senders.get(workspaceKey) ?? new Map<symbol, WorkspaceConversationPromptSenderEntry>();
  scoped.set(token, { focused, send });
  senders.set(workspaceKey, scoped);
  emitChange();

  return () => {
    const current = senders.get(workspaceKey);
    current?.delete(token);
    if (current?.size === 0) senders.delete(workspaceKey);
    emitChange();
  };
}

export type WorkspaceConversationPromptAvailability = "ready" | "unavailable";

export function getWorkspaceConversationPromptAvailability(
  scope: WorkspaceConversationPromptScope,
): WorkspaceConversationPromptAvailability {
  return getSenderEntry(getWorkspaceKey(scope.workspacePath, scope.workspaceIdentity))
    ? "ready"
    : "unavailable";
}

export function subscribeWorkspaceConversationPromptRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 把提示词交给当前 workspace 主对话的发送 owner。返回 false 表示没有已注册的
 * 主 pane（调用方应据此不渲染入口，而非点击后兜底）。发送失败由 SessionPane
 * 的 pane-local 错误横幅呈现，这里不再重复上报。
 */
export function requestWorkspaceConversationPrompt(
  scope: WorkspaceConversationPromptScope,
  text: string,
): boolean {
  const entry = getSenderEntry(getWorkspaceKey(scope.workspacePath, scope.workspaceIdentity));
  if (!entry) return false;
  void entry.send(text).catch(() => {});
  return true;
}
