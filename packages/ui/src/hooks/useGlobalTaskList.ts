import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  WindowHostControllerTaskListResult,
  WindowHostControllerTaskListItem,
  ZCodeTaskListKind,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  buildFallbackScopeParams,
  getFallbackTaskListRefreshDelayMs,
  isWindowControllerChannelMissingError,
  isWindowControllerUnavailable,
  listTaskListViaPartitionRpc,
  markWindowControllerUnavailable,
} from "@/lib/taskListControllerFallback.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import type { WindowControllerTaskListVersion } from "@/v4/windowControllerTaskListRegistry.js";

type GlobalTaskListItem = WindowHostControllerTaskListItem;

const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]): ZCodeTaskListWorkspaceScope[] {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const tab of workspaceTabs) {
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const controller = baseServices.windowControllerService;
  const controllerRegistry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  const controllerRevision = useSyncExternalStore(
    controllerRegistry?.subscribe ?? subscribeToNothing,
    controllerRegistry?.getRevision ?? zeroRevision,
    controllerRegistry?.getRevision ?? zeroRevision,
  );
  const workspaceSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
      )
      .sort(
        ([leftKey, leftPath], [rightKey, rightPath]) =>
          leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
      ),
  );
  const workspaceSourceGenerationSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) =>
          [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            tab.workspacePath,
            tab.remoteSessionId?.trim() || null,
          ] as const,
      )
      .sort(
        ([leftKey, leftPath, leftSession], [rightKey, rightPath, rightSession]) =>
          leftKey.localeCompare(rightKey) ||
          leftPath.localeCompare(rightPath) ||
          (leftSession ?? "").localeCompare(rightSession ?? ""),
      ),
  );
  const workspaceScopes = useMemo(
    () => buildWorkspaceScopes(params.workspaceTabs),
    // workspaceSignature 是标准化后的 scope 值签名，避免父组件重建 tabs 数组时重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceSignature],
  );
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs
        .map((tab) => {
          const workspace = selectWorkspaceZCodeState(
            state,
            tab.workspacePath,
            tab.workspaceIdentity,
          );
          return [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            workspace.taskListVersion,
          ] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  const [items, setItems] = useState<GlobalTaskListItem[]>([]);
  const itemsRef = useRef<GlobalTaskListItem[]>(items);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(workspaceScopes.length > 0);
  const requestSerialRef = useRef(0);
  const manualRefreshSerialRef = useRef(0);
  // 回退路径的 workspace 事件订阅只在确认 controller 通道缺失后启动（见 load 内标记），
  // 桌面等 controller 完备的宿主不添加重复刷新源。
  const [fallbackActive, setFallbackActive] = useState(false);
  const fallbackTaskServiceRef = useRef(baseServices.zcodeTaskService);
  fallbackTaskServiceRef.current = baseServices.zcodeTaskService;
  const debouncedReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useMemo(
    () => ({
      kind: params.kind,
      workspaceScopes,
      sortBy: params.sortBy,
      search: params.searchQuery.trim() || undefined,
      limit: params.expanded ? undefined : params.collapsedLimit,
    }),
    [
      params.collapsedLimit,
      params.expanded,
      params.kind,
      params.searchQuery,
      params.sortBy,
      workspaceScopes,
    ],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const load = useCallback(
    async (version: WindowControllerTaskListVersion) => {
      const requestSerial = ++requestSerialRef.current;
      if (workspaceScopes.length === 0) {
        setItems([]);
        itemsRef.current = [];
        setTotal(0);
        setHasMore(false);
        setLoading(false);
        return;
      }
      const applyResult = (result: WindowHostControllerTaskListResult) => {
        if (requestSerialRef.current !== requestSerial) {
          return;
        }
        // Controller 的每个 activity 帧（运行中任务的 tool 调用等）都会让本 hook 重查，
        // 而 attachTaskListRowActivity 与 tasks-index join 每次都产生全新对象。下游（grouped 视图）
        // 只能按引用判等，于是整棵列表树换代重渲染并重测量虚拟器。这里与 sessions-index lane 同款
        // 逐条引用稳定化：内容等价复用旧对象，整表等价复用旧数组。
        const nextItems = stabilizeTaskListItems(
          itemsRef.current,
          result.items.map((item) =>
            item.activity ? attachTaskListRowActivity(item, item.activity) : item,
          ),
        );
        itemsRef.current = nextItems;
        setItems(nextItems);
        setTotal(result.total);
        setHasMore(result.hasMore);
      };

      const controllerUnavailable = controller ? isWindowControllerUnavailable(controller) : false;
      if (!controllerRegistry) {
        // 原子切换后 base attachment 必须提供 Controller；字段缺失代表 Host/Renderer 版本不一致。
        // 这里不能静默回退分区查询：controllerTaskFacts 等消费方依赖“无 controller 就不查询”的
        // 契约（useGroupedTaskView 同一宿主下共用本 hook），回退会让这类宿主多出一轮分区 RPC。
        logger.error("[useGlobalTaskList] window Host Controller channel unavailable");
        setLoading(false);
        return;
      }
      if (!controllerUnavailable) {
        setLoading(true);
        try {
          const result = await controllerRegistry.list(queryKey, version, query);
          applyResult(result);
          return;
        } catch (error) {
          if (!isWindowControllerChannelMissingError(error)) {
            if (requestSerialRef.current === requestSerial) {
              // Controller 查询失败时保留最后可信列表，避免单 source 异常清空其他 workspace。
              logger.error(`[useGlobalTaskList] Controller 加载 ${params.kind} 列表失败`, error);
            }
            return;
          }
          // Bugfix: 网页会话宿主（zcode-server-cli daemon）不注册 window-controller 通道，
          // listTaskList 每次都以 "Unknown channel" 超时失败，置顶/时间线/归档区长期空白，
          // 置顶成功的会话从 workspace 列表移除后无处展示，网页端表现为“无法置顶”。
          // 这里确认缺通道后标记该 controller 实例并切换到 tasks-index 分区查询回退。
          if (controller) {
            markWindowControllerUnavailable(controller);
          }
          setFallbackActive(true);
        } finally {
          if (requestSerialRef.current === requestSerial) {
            setLoading(false);
          }
        }
        if (requestSerialRef.current !== requestSerial) {
          return;
        }
      } else {
        // 首次 load 即命中 WeakSet 标记（跨实例持久）：直接走回退并激活事件订阅。
        setFallbackActive(true);
      }

      setLoading(true);
      try {
        const result = await listTaskListViaPartitionRpc({
          zcodeTaskService: fallbackTaskServiceRef.current,
          query,
        });
        applyResult(result);
      } catch (error) {
        if (requestSerialRef.current === requestSerial) {
          logger.error(`[useGlobalTaskList] 回退分区查询 ${params.kind} 列表失败`, error);
        }
      } finally {
        if (requestSerialRef.current === requestSerial) {
          setLoading(false);
        }
      }
    },
    [controller, controllerRegistry, params.kind, query, queryKey, workspaceScopes],
  );

  const refresh = useCallback(async () => {
    manualRefreshSerialRef.current += 1;
    await load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
      manualRefreshSerial: manualRefreshSerialRef.current,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!fallbackActive) {
      return;
    }
    const taskService = fallbackTaskServiceRef.current;
    const timerRef = debouncedReloadTimerRef;
    const scheduleReload = (delayMs: number) => {
      if (delayMs <= 0) {
        void refreshRef.current();
        return;
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void refreshRef.current();
      }, delayMs);
    };
    const disposables = workspaceScopes.map((scope) =>
      taskService.onDynamicWorkspaceEvent(buildFallbackScopeParams(scope))((event) => {
        if (event.type !== "workspace_task_list_changed") {
          return;
        }
        // 与 useWorkspaceTaskLists 同款防御：事件归属必须与订阅 scope 一致，避免同路径串扰。
        if (
          buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity) !==
          buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity)
        ) {
          return;
        }
        const delayMs = getFallbackTaskListRefreshDelayMs(event.reason);
        if (delayMs === null) {
          return;
        }
        scheduleReload(delayMs);
      }),
    );
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [fallbackActive, workspaceScopes]);

  useEffect(() => {
    // 远程 workspace 从断开占位恢复为在线 session 时 identity/path 不变，
    // taskListVersion 也可能尚未变化，旧缓存因此永久保留连接前的空结果。remoteSessionId
    // 只作为 source 代际触发重查，不改变 workspaceIdentity 与 Controller 查询契约。
    void load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  const hasRemoteScope = params.workspaceTabs.some((tab) => Boolean(tab.workspaceIdentity));
  return {
    items,
    total,
    hasMore,
    loading,
    syncingRemoteWorkspaces: loading && hasRemoteScope,
    refresh,
  };
}
