/* eslint-disable max-lines -- 终端 tab/拆分分组编排、PTY 生命周期回调与布局推导共用同一份 panelState，拆文件会引入跨文件状态同步。 */
import { Plus, SplitSquareHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TID_TERMINAL, TID_TERMINAL_CLOSE_BUTTON, TID_TERMINAL_SPLIT_BUTTON } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList } from "@/components/ui/tabs.js";
import { cn } from "@/components/lib/utils.js";
import { getPathLeaf } from "@/lib/path.js";
import { TerminalTabTrigger } from "@/terminal/TerminalTabTrigger.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import {
  closeTerminalSession,
  createTerminalSession,
  createWorkspaceTerminalState,
  ensureWorkspaceTerminalState,
  exitTerminalSession,
  formatTerminalTabTitle,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  splitTerminalSession,
  type TerminalPanelState,
  type TerminalSessionDescriptor,
} from "@/terminal/terminalPanelState.js";

export function Terminal({
  services,
  cwd,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  cwd?: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const workspaceKey = workspaceIdentity?.trim() || cwd || "__default__";
  const [panelState, setPanelState] = useState<TerminalPanelState>(() => {
    const { session, workspace } = createWorkspaceTerminalState({
      workspaceKey,
      services,
      cwd,
    });
    return {
      sessions: {
        [session.id]: session,
      },
      workspaces: {
        [workspaceKey]: workspace,
      },
    };
  });
  const closePanelAfterExitWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    // 业务逻辑：终端会话按 workspace identity 隔离保存，切换 workspace 时只切换可见 tab，
    // 不卸载旧 workspace 的 xterm/PTY，避免长时间运行的命令因为 React 生命周期变化被杀掉。
    // PTY exit 会删除最后一个 session；面板下次重新打开时也通过这里懒创建新终端。
    setPanelState((current) =>
      ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      }),
    );
  }, [cwd, isVisible, services, workspaceKey]);

  useEffect(() => {
    const exitedWorkspaceKey = closePanelAfterExitWorkspaceRef.current;
    if (!exitedWorkspaceKey) {
      return;
    }

    closePanelAfterExitWorkspaceRef.current = null;
    if (exitedWorkspaceKey === workspaceKey) {
      onClose();
    }
  }, [onClose, panelState, workspaceKey]);

  useEffect(() => {
    if (!openWorkspaceKeys) {
      return;
    }

    // 终端现在会跨 workspace 切换保活，但 workspace tab 被真正关闭后，
    // 对应的隐藏终端不能继续占着 PTY 进程；这里按仍打开的 workspace key 做回收。
    const retainedWorkspaceKeys = new Set(openWorkspaceKeys);
    retainedWorkspaceKeys.add(workspaceKey);
    setPanelState((current) => {
      const removedWorkspaceKeys = Object.keys(current.workspaces).filter(
        (key) => !retainedWorkspaceKeys.has(key),
      );
      if (removedWorkspaceKeys.length === 0) {
        return current;
      }

      const nextWorkspaces = { ...current.workspaces };
      const nextSessions = { ...current.sessions };
      for (const removedWorkspaceKey of removedWorkspaceKeys) {
        const workspace = nextWorkspaces[removedWorkspaceKey];
        delete nextWorkspaces[removedWorkspaceKey];
        for (const sessionId of workspace?.sessionIds ?? []) {
          delete nextSessions[sessionId];
        }
      }

      return {
        sessions: nextSessions,
        workspaces: nextWorkspaces,
      };
    });
  }, [openWorkspaceKeys, workspaceKey]);

  const handleShellLabelChange = useCallback((sessionId: string, shellLabel: string | null) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session || session.shellLabel === shellLabel) {
        return current;
      }

      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...session,
            shellLabel,
          },
        },
      };
    });
  }, []);

  const handleCreateSession = useCallback(() => {
    setPanelState((current) => {
      const ensured = ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      });
      const workspace = ensured.workspaces[workspaceKey];
      if (!workspace) {
        return ensured;
      }

      const session = createTerminalSession({
        workspaceKey,
        services,
        cwd,
        index: getNextTerminalSessionIndex(ensured, workspaceKey),
      });
      logger.info("[Terminal] create terminal tab", {
        cwd,
        terminalTabId: session.id,
        workspaceKey,
      });

      return {
        sessions: {
          ...ensured.sessions,
          [session.id]: session,
        },
        workspaces: {
          ...ensured.workspaces,
          [workspaceKey]: {
            sessionIds: [...workspace.sessionIds, session.id],
            activeSessionId: session.id,
            // 新终端归入自己的单窗口组：既有拆分组的成员关系保持不变，
            // 切回组内任一 tab 即恢复整组拆分布局。
            splitGroups: [...workspace.splitGroups, [session.id]],
          },
        },
      };
    });
  }, [cwd, services, workspaceKey]);

  const handleSplitSession = useCallback(() => {
    setPanelState((current) => {
      const next = splitTerminalSession(current, {
        workspaceKey,
        services,
        cwd,
      });
      if (next === current) {
        return current;
      }

      const workspace = next.workspaces[workspaceKey];
      logger.info("[Terminal] split terminal pane", {
        cwd,
        splitGroups: workspace?.splitGroups,
        terminalTabId: workspace?.activeSessionId,
        workspaceKey,
      });
      return next;
    });
  }, [cwd, services, workspaceKey]);

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      const closeAction = getTerminalSessionCloseAction(panelState, sessionId);
      if (closeAction === "close-panel") {
        // 旧 UI 在只剩一个 tab 时直接隐藏关闭按钮，用户无法从 tab 完成关闭。
        // 最后一个 tab 的关闭语义是收起整个面板并保活 session，与右上角关闭面板按钮保持一致。
        logger.info("[Terminal] close terminal panel from last tab", {
          terminalTabId: sessionId,
          workspaceKey,
        });
        onClose();
        return;
      }

      if (closeAction !== "close-session") {
        return;
      }

      setPanelState((current) => {
        const session = current.sessions[sessionId];
        const next = closeTerminalSession(current, sessionId);
        if (!session || next === current) {
          return current;
        }

        logger.info("[Terminal] close terminal tab", {
          terminalTabId: sessionId,
          workspaceKey: session.workspaceKey,
        });
        return next;
      });
    },
    [onClose, panelState, workspaceKey],
  );

  const handleSessionExit = useCallback(
    (sessionId: string, exitCode: number) => {
      setPanelState((current) => {
        const exitedWorkspaceKey = current.sessions[sessionId]?.workspaceKey;
        const result = exitTerminalSession(current, sessionId, workspaceKey);
        if (result.action === "none") {
          return current;
        }

        // 不能只在 xterm 中写“进程已退出”、让 descriptor 留在 tab registry。
        // PTY exit 是 session 生命周期终点，必须同步删除 tab；只有当前 workspace 的最后一个 tab 才关闭面板。
        logger.info("[Terminal] auto close exited terminal tab", {
          action: result.action,
          exitCode,
          terminalTabId: sessionId,
          workspaceKey: exitedWorkspaceKey,
        });
        if (result.action === "close-panel") {
          closePanelAfterExitWorkspaceRef.current = exitedWorkspaceKey ?? null;
        }
        return result.state;
      });
    },
    [workspaceKey],
  );

  const handleActivateSession = useCallback((sessionId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session) {
        return current;
      }

      const workspace = current.workspaces[session.workspaceKey];
      if (!workspace || workspace.activeSessionId === sessionId) {
        return current;
      }

      // 只切换焦点；可见布局由焦点终端所在 splitGroups 组推导，
      // 切回拆分组成员会整组恢复拆分布局，不破坏组关系。
      return {
        ...current,
        workspaces: {
          ...current.workspaces,
          [session.workspaceKey]: {
            ...workspace,
            activeSessionId: sessionId,
          },
        },
      };
    });
  }, []);

  const workspace = panelState.workspaces[workspaceKey];
  const currentSessions =
    workspace?.sessionIds
      .map((sessionId) => panelState.sessions[sessionId])
      .filter((session): session is TerminalSessionDescriptor => Boolean(session)) ?? [];
  const activeSession =
    currentSessions.find((session) => session.id === workspace?.activeSessionId) ??
    currentSessions[0] ??
    null;
  const allSessions = Object.values(panelState.sessions);
  // 可见集合 = 焦点终端所在分组；组内 ≥2 个成员即为拆分布局（等宽均分）。
  const activeGroup =
    activeSession && workspace
      ? (workspace.splitGroups.find((group) => group.includes(activeSession.id)) ?? [
          activeSession.id,
        ])
      : [];
  const isSplitView = activeGroup.length > 1;

  // 修复说明：关闭面板只收起 UI，不 dispose tab。真正关闭某个终端由 tab 上的关闭按钮负责，
  // 这样 workspace/task 切换或面板收起都不会中断正在运行的命令。
  return (
    <section
      data-testid={TID_TERMINAL}
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-background p-3 pb-2"
    >
      <Tabs
        value={activeSession?.id ?? ""}
        onValueChange={handleActivateSession}
        className="h-full min-h-0 gap-2"
      >
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="truncate text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "terminal.title" })}
            </div>
            {activeSession?.shellLabel ? (
              <div className="shrink-0 text-ui-base text-foreground-subtle">
                {activeSession.shellLabel}
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto !scrollbar-hide">
            <TabsList className="flex !h-7 w-max justify-start gap-1 rounded-none bg-transparent p-0">
              {currentSessions.map((session) => {
                const projectName =
                  getPathLeaf(session.cwd ?? "") || intl.formatMessage({ id: "terminal.title" });
                const title = formatTerminalTabTitle(projectName, session.index);
                return (
                  <TerminalTabTrigger
                    key={session.id}
                    session={session}
                    title={title}
                    closeLabel={intl.formatMessage({ id: "terminal.closeTab" }, { title })}
                    isActive={session.id === activeSession?.id}
                    onClose={handleCloseSession}
                  />
                );
              })}
            </TabsList>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!isOfficeMode && (
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleSplitSession}
                data-testid={TID_TERMINAL_SPLIT_BUTTON}
                title={intl.formatMessage({ id: "terminal.split" })}
                aria-label={intl.formatMessage({ id: "terminal.split" })}
              >
                <SplitSquareHorizontal className="h-4 w-4" />
              </Button>
            )}
            {!isOfficeMode && (
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleCreateSession}
                title={intl.formatMessage({ id: "terminal.new" })}
                aria-label={intl.formatMessage({ id: "terminal.new" })}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              onClick={onClose}
              data-testid={TID_TERMINAL_CLOSE_BUTTON}
              title={intl.formatMessage({ id: "terminal.close" })}
              aria-label={intl.formatMessage({ id: "terminal.close" })}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 布局由焦点终端所在 splitGroups 组推导：组成员按左→右等宽展示，其余（含其他 workspace）隐藏不卸载，
            PTY 与 scrollback 不中断。 */}
        <div className={cn("flex min-h-0 flex-1 overflow-hidden", isSplitView && "gap-2")}>
          {allSessions.map((session) => {
            const visible =
              session.workspaceKey === workspaceKey && activeGroup.includes(session.id);
            return (
              <div
                key={session.id}
                data-state={visible ? "active" : "inactive"}
                onFocus={visible ? () => handleActivateSession(session.id) : undefined}
                className={cn(
                  "min-w-0 overflow-hidden",
                  visible ? "flex-1" : "hidden",
                  visible && isSplitView && "rounded-lg border border-border",
                )}
              >
                <TerminalSession
                  sessionId={session.id}
                  services={session.services}
                  cwd={session.cwd}
                  isVisible={isVisible && visible}
                  isFocused={isVisible && visible && session.id === activeSession?.id}
                  isPanelResizing={isPanelResizing}
                  isWindowsDesktop={isWindowsDesktop}
                  onShellLabelChange={handleShellLabelChange}
                  onExit={handleSessionExit}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                />
              </div>
            );
          })}
        </div>
      </Tabs>
    </section>
  );
}
