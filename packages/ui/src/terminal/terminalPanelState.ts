import type { IServiceAccessor } from "@zcode/services";
import { createUuid } from "@zcode/shared";

export interface TerminalSessionDescriptor {
  id: string;
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
  shellLabel: string | null;
}

export interface TerminalWorkspaceState {
  sessionIds: string[];
  activeSessionId: string;
  /**
   * 终端分组（含单窗口组）：每组内成员按左→右排序，每个 session 恰好属于一个组。
   * 可见集合 = activeSessionId 所在组的成员；长度 ≥2 的组即拆分组，整组等宽展示。
   * 组关系跨「+」新建与 tab 切换持久保持（切回组内任一成员即恢复整组布局），
   * 只有关闭成员才会收缩组；组顺序与创建顺序一致（拆分目标恒为最后打开的组尾成员）。
   */
  splitGroups: string[][];
}

export interface TerminalPanelState {
  sessions: Record<string, TerminalSessionDescriptor>;
  workspaces: Record<string, TerminalWorkspaceState>;
}

export function createTerminalSession(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
}): TerminalSessionDescriptor {
  return {
    id: createUuid(),
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: params.index,
    shellLabel: null,
  };
}

export function createWorkspaceTerminalState(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
}): {
  session: TerminalSessionDescriptor;
  workspace: TerminalWorkspaceState;
} {
  const session = createTerminalSession({
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: 1,
  });

  return {
    session,
    workspace: {
      sessionIds: [session.id],
      activeSessionId: session.id,
      splitGroups: [[session.id]],
    },
  };
}

export function getNextTerminalSessionIndex(
  state: TerminalPanelState,
  workspaceKey: string,
): number {
  const workspace = state.workspaces[workspaceKey];
  const usedIndices = new Set(
    workspace?.sessionIds
      .map((sessionId) => state.sessions[sessionId]?.index)
      .filter((index): index is number => typeof index === "number") ?? [],
  );

  // 把 nextIndex 作为只增不减的派生状态保存，会让关闭编号 2 后再新建错误地得到 3。
  // 编号事实已经存在于 session descriptor 中，创建时从现存 session 推导最小空位，避免两份状态漂移。
  for (let index = 1; ; index += 1) {
    if (!usedIndices.has(index)) {
      return index;
    }
  }
}

export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index === 1 ? projectName : `${projectName} ${index}`;
}

type TerminalSessionCloseAction = "none" | "close-panel" | "close-session";

interface TerminalSessionExitResult {
  state: TerminalPanelState;
  action: TerminalSessionCloseAction;
}

export function getTerminalSessionCloseAction(
  state: TerminalPanelState,
  sessionId: string,
): TerminalSessionCloseAction {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return "none";
  }

  return workspace.sessionIds.length === 1 ? "close-panel" : "close-session";
}

export function closeTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
): TerminalPanelState {
  if (getTerminalSessionCloseAction(state, sessionId) !== "close-session") {
    return state;
  }

  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace) {
    return state;
  }

  const closingIndex = workspace.sessionIds.indexOf(sessionId);
  const nextSessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
  // 关闭成员从所在组移除；组内剩余 ≥2 才保持拆分展示（单成员组保留为普通单窗口组）。
  const nextSplitGroups = workspace.splitGroups
    .map((group) => group.filter((id) => id !== sessionId))
    .filter((group) => group.length > 0);

  // 焦点终端被关闭时，落点优先取同组相邻窗口（左邻优先，其次右邻），符合拆分布局的视觉相邻关系；
  // 同组无邻居（单成员组）时沿用 sessionIds 相邻规则。
  let fallbackSessionId = nextSessionIds[Math.max(0, closingIndex - 1)] ?? nextSessionIds[0];
  if (workspace.activeSessionId === sessionId) {
    const closingGroup = workspace.splitGroups.find((group) => group.includes(sessionId));
    const rowIndex = closingGroup?.indexOf(sessionId) ?? -1;
    const groupNeighbor =
      rowIndex >= 0 ? (closingGroup?.[rowIndex - 1] ?? closingGroup?.[rowIndex + 1]) : undefined;
    if (groupNeighbor) {
      fallbackSessionId = groupNeighbor;
    }
  }
  if (!fallbackSessionId) {
    return state;
  }

  const { [sessionId]: _closedSession, ...nextSessions } = state.sessions;
  return {
    sessions: nextSessions,
    workspaces: {
      ...state.workspaces,
      [session.workspaceKey]: {
        sessionIds: nextSessionIds,
        splitGroups: nextSplitGroups,
        activeSessionId:
          workspace.activeSessionId === sessionId ? fallbackSessionId : workspace.activeSessionId,
      },
    },
  };
}

export function exitTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
  activeWorkspaceKey: string,
): TerminalSessionExitResult {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return { state, action: "none" };
  }

  if (workspace.sessionIds.length > 1) {
    return {
      state: closeTerminalSession(state, sessionId),
      action: "close-session",
    };
  }

  // PTY 自身已经退出时，最后一个 tab 不能像手动关闭那样只收起面板并保活。
  // 这里同时删除 session/workspace 记录；重新打开该 workspace 时再由 ensure 懒创建新 PTY。
  const { [sessionId]: _exitedSession, ...nextSessions } = state.sessions;
  const { [session.workspaceKey]: _exitedWorkspace, ...nextWorkspaces } = state.workspaces;
  return {
    state: {
      sessions: nextSessions,
      workspaces: nextWorkspaces,
    },
    action: session.workspaceKey === activeWorkspaceKey ? "close-panel" : "close-session",
  };
}

export function ensureWorkspaceTerminalState(
  state: TerminalPanelState,
  params: {
    workspaceKey: string;
    services: IServiceAccessor;
    cwd?: string;
  },
): TerminalPanelState {
  const existingWorkspace = state.workspaces[params.workspaceKey];
  if (existingWorkspace?.sessionIds.some((sessionId) => state.sessions[sessionId])) {
    return state;
  }

  const { session, workspace } = createWorkspaceTerminalState(params);
  return {
    sessions: {
      ...state.sessions,
      [session.id]: session,
    },
    workspaces: {
      ...state.workspaces,
      [params.workspaceKey]: workspace,
    },
  };
}

export function splitTerminalSession(
  state: TerminalPanelState,
  params: {
    workspaceKey: string;
    services: IServiceAccessor;
    cwd?: string;
  },
): TerminalPanelState {
  const ensured = ensureWorkspaceTerminalState(state, params);
  const workspace = ensured.workspaces[params.workspaceKey];
  // 拆分目标固定为「最后打开」的存活终端（创建顺序最后一个）；连续拆分时上一轮的新窗口
  // 就是本轮目标，形成从左到右逐段均分的链。目标缺失说明 workspace 记录异常，保持原状态。
  const targetSessionId = workspace?.sessionIds[workspace.sessionIds.length - 1];
  if (!workspace || !targetSessionId) {
    return ensured;
  }

  const newSession = createTerminalSession({
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: getNextTerminalSessionIndex(ensured, params.workspaceKey),
  });

  // 新窗口插到目标所在组、目标的右侧；目标不在任何组（正常写入路径不可达）时以 [target, new] 新建一组兜底。
  const targetGroupIndex = workspace.splitGroups.findIndex((group) =>
    group.includes(targetSessionId),
  );
  const splitGroups =
    targetGroupIndex >= 0
      ? workspace.splitGroups.map((group, groupIndex) => {
          if (groupIndex !== targetGroupIndex) {
            return group;
          }
          const targetIndex = group.indexOf(targetSessionId);
          return [
            ...group.slice(0, targetIndex + 1),
            newSession.id,
            ...group.slice(targetIndex + 1),
          ];
        })
      : [...workspace.splitGroups, [targetSessionId, newSession.id]];

  return {
    sessions: {
      ...ensured.sessions,
      [newSession.id]: newSession,
    },
    workspaces: {
      ...ensured.workspaces,
      [params.workspaceKey]: {
        ...workspace,
        sessionIds: [...workspace.sessionIds, newSession.id],
        activeSessionId: newSession.id,
        splitGroups,
      },
    },
  };
}
