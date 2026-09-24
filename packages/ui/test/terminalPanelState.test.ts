import assert from "node:assert/strict";
import test from "node:test";
import type { IServiceAccessor } from "@zcode/services";
import {
  closeTerminalSession,
  createTerminalSession,
  createWorkspaceTerminalState,
  exitTerminalSession,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  splitTerminalSession,
  type TerminalPanelState,
} from "../src/terminal/terminalPanelState.js";

const services = {} as IServiceAccessor;
const WORKSPACE_KEY = "ws-identity";
const SPLIT_PARAMS = { workspaceKey: WORKSPACE_KEY, services, cwd: "/tmp/demo" };

function createInitialState(): TerminalPanelState {
  const { session, workspace } = createWorkspaceTerminalState({
    workspaceKey: WORKSPACE_KEY,
    services,
    cwd: "/tmp/demo",
  });
  return { sessions: { [session.id]: session }, workspaces: { [WORKSPACE_KEY]: workspace } };
}

/** 复刻「+」新建终端路径：追加 session、归入新的单窗口组、焦点交给新终端。 */
function appendSession(state: TerminalPanelState): TerminalPanelState {
  const workspace = state.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  const session = createTerminalSession({
    workspaceKey: WORKSPACE_KEY,
    services,
    cwd: "/tmp/demo",
    index: getNextTerminalSessionIndex(state, WORKSPACE_KEY),
  });
  return {
    sessions: { ...state.sessions, [session.id]: session },
    workspaces: {
      ...state.workspaces,
      [WORKSPACE_KEY]: {
        ...workspace,
        sessionIds: [...workspace.sessionIds, session.id],
        activeSessionId: session.id,
        splitGroups: [...workspace.splitGroups, [session.id]],
      },
    },
  };
}

/** 复刻渲染层推导：可见集合 = 焦点终端所在分组。 */
function visibleGroupOf(state: TerminalPanelState, sessionId: string): string[] {
  const workspace = state.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  return workspace.splitGroups.find((group) => group.includes(sessionId)) ?? [sessionId];
}

function activate(state: TerminalPanelState, sessionId: string): TerminalPanelState {
  const workspace = state.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [WORKSPACE_KEY]: { ...workspace, activeSessionId: sessionId },
    },
  };
}

test("split creates a new pane right of the last opened terminal and focuses it", () => {
  const state = createInitialState();
  const firstId = state.workspaces[WORKSPACE_KEY].sessionIds[0];
  assert.ok(firstId);

  const next = splitTerminalSession(state, SPLIT_PARAMS);
  const workspace = next.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  assert.deepEqual(workspace.splitGroups, [[firstId, workspace.activeSessionId]]);
  assert.deepEqual(workspace.sessionIds, [firstId, workspace.activeSessionId]);
  assert.notEqual(workspace.activeSessionId, firstId);
  // 新窗口编号取最小空位：首终端为 1，拆分新开为 2。
  assert.equal(next.sessions[workspace.activeSessionId]?.index, 2);
  assert.deepEqual(visibleGroupOf(next, workspace.activeSessionId).length, 2);
});

test("repeated splits keep growing the same group from the last opened terminal", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  state = splitTerminalSession(state, SPLIT_PARAMS);

  const workspace = state.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  assert.deepEqual(workspace.splitGroups, [workspace.sessionIds]);
  assert.equal(workspace.splitGroups[0]?.length, 3);
  // 焦点始终落在最右侧新窗口，连续拆分即对「最后打开」逐段均分。
  assert.equal(workspace.activeSessionId, workspace.sessionIds[2]);
  assert.deepEqual(workspace.sessionIds.map((id) => state.sessions[id]?.index).sort(), [1, 2, 3]);
});

test("plus-style append starts its own group and keeps the split group intact", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  const splitGroup = state.workspaces[WORKSPACE_KEY].splitGroups[0];
  assert.ok(splitGroup);

  state = appendSession(state);
  const workspace = state.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  const [appendedId] = workspace.sessionIds.slice(-1);
  assert.ok(appendedId);
  // 新终端是独立的单窗口组；拆分组原样保留。
  assert.deepEqual(visibleGroupOf(state, appendedId), [appendedId]);
  assert.deepEqual(workspace.splitGroups, [splitGroup, [appendedId]]);

  // 切回拆分组成员：整组恢复拆分布局（焦点组成员即布局来源）。
  const restored = activate(state, splitGroup[0]);
  assert.deepEqual(visibleGroupOf(restored, splitGroup[0]), splitGroup);
  assert.equal(restored.workspaces[WORKSPACE_KEY].splitGroups.length, 2);
});

test("split after a plus-style append groups the appended terminal with its new pane", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  state = appendSession(state);
  state = splitTerminalSession(state, SPLIT_PARAMS);

  const workspace = state.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  // 目标（最后打开的单窗口组）拆分后归入同一组，既有拆分组不受影响。
  assert.deepEqual(workspace.splitGroups, [
    workspace.sessionIds.slice(0, 2),
    workspace.sessionIds.slice(2),
  ]);
  assert.equal(workspace.activeSessionId, workspace.sessionIds[3]);
  assert.deepEqual(visibleGroupOf(state, workspace.activeSessionId), workspace.sessionIds.slice(2));
});

test("closing a middle pane shrinks the group and keeps focus", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  state = splitTerminalSession(state, SPLIT_PARAMS);
  const [firstId, middleId, lastId] = state.workspaces[WORKSPACE_KEY].sessionIds;
  assert.ok(firstId && middleId && lastId);

  const closed = closeTerminalSession(state, middleId);
  const workspace = closed.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  assert.deepEqual(workspace.splitGroups, [[firstId, lastId]]);
  assert.equal(workspace.activeSessionId, lastId);
  assert.equal(closed.sessions[middleId], undefined);
});

test("closing the focused pane collapses a two-pane group into a plain single window", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  const [firstId, secondId] = state.workspaces[WORKSPACE_KEY].sessionIds;
  assert.ok(firstId && secondId);

  const closed = closeTerminalSession(state, secondId);
  const workspace = closed.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  assert.deepEqual(workspace.splitGroups, [[firstId]]);
  assert.equal(workspace.activeSessionId, firstId);
  assert.deepEqual(workspace.sessionIds, [firstId]);
});

test("closing the focused pane prefers the left group neighbor in larger groups", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  state = splitTerminalSession(state, SPLIT_PARAMS);
  const [firstId, middleId, lastId] = state.workspaces[WORKSPACE_KEY].sessionIds;
  assert.ok(firstId && middleId && lastId);

  const closed = closeTerminalSession(state, lastId);
  const workspace = closed.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  assert.deepEqual(workspace.splitGroups, [[firstId, middleId]]);
  assert.equal(workspace.activeSessionId, middleId);
});

test("closing a non-focused split member keeps focus on the other group", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);
  state = appendSession(state);
  const [, secondId] = state.workspaces[WORKSPACE_KEY].splitGroups[0];
  assert.ok(secondId);

  const closed = closeTerminalSession(state, secondId);
  const workspace = closed.workspaces[WORKSPACE_KEY];
  assert.ok(workspace);
  // 焦点在另一组的成员上：拆分组收缩为单窗口组，焦点保持不动。
  assert.deepEqual(workspace.splitGroups, [[workspace.sessionIds[0]], [workspace.sessionIds[1]]]);
  assert.equal(workspace.activeSessionId, workspace.sessionIds[1]);
});

test("split rows stay scoped to their workspace", () => {
  const state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);

  const next = splitTerminalSession(state, {
    ...SPLIT_PARAMS,
    workspaceKey: "ws-other",
  });

  // 目标 workspace 正常拆分
  const otherWorkspace = next.workspaces["ws-other"];
  assert.ok(otherWorkspace);
  assert.equal(otherWorkspace.splitGroups.length, 1);
  assert.equal(otherWorkspace.splitGroups[0]?.length, 2);
  // 来源 workspace 的分组与 sessions 不受影响
  assert.deepEqual(
    next.workspaces[WORKSPACE_KEY]?.splitGroups,
    state.workspaces[WORKSPACE_KEY]?.splitGroups,
  );
  assert.deepEqual(Object.keys(next.sessions).length, Object.keys(state.sessions).length + 2);
});

test("pty exit of the last session still removes the workspace together with its groups", () => {
  let state = splitTerminalSession(createInitialState(), SPLIT_PARAMS);

  // 逐个退出到只剩一个 session 后，最后一个退出应清空 workspace 记录（既有语义）。
  // 状态更新全部不可变（filter 产生新数组），循环开始时的求值结果不受后续重赋值影响。
  for (const sessionId of state.workspaces[WORKSPACE_KEY].sessionIds) {
    const result = exitTerminalSession(state, sessionId, WORKSPACE_KEY);
    state = result.state;
  }
  assert.equal(state.workspaces[WORKSPACE_KEY], undefined);
  assert.equal(Object.keys(state.sessions).length, 0);
});

test("single tab still reports close-panel and direct close stays a no-op", () => {
  const state = createInitialState();
  const onlyId = state.workspaces[WORKSPACE_KEY].sessionIds[0];
  assert.ok(onlyId);
  assert.equal(getTerminalSessionCloseAction(state, onlyId), "close-panel");
  assert.equal(closeTerminalSession(state, onlyId), state);
});
