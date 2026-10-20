import type {
  IWindowControllerService,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";

/**
 * 网页会话宿主（zcode-server-cli daemon）不注册 IWindowControllerService，但
 * RemoteServiceAccess 仍会为其创建 RPC 代理：listTaskList / subscribeControllerV4 每次调用
 * 都以 "Unknown channel" 超时失败（rpc/channelServer.ts collectPendingRequest），全局
 * Pinned/Timeline/Archived 区块因此永远为空——置顶成功的会话按 membership 从 workspace
 * 列表移除后无处展示，在网页端表现为“无法置顶”。
 * 这里提供回退数据源：直接使用 zcodeTaskService 的 tasks-index 分区查询
 * （listPinnedTasks / listTasks / listArchivedTasks，daemon 已支持，与侧边栏
 * useWorkspaceTaskLists 同源），并用 WeakSet 记住已确认缺通道的 controller 实例，
 * 后续 load 不再重复支付 1s 通道超时。
 */

const UNAVAILABLE_CONTROLLERS = new WeakSet<object>();

export function isWindowControllerChannelMissingError(error: unknown): boolean {
  // channelClient 把 ChannelServer 的 PromiseError 还原为 name="Unknown channel" 的 Error。
  return error instanceof Error && error.name === "Unknown channel";
}

export function markWindowControllerUnavailable(controller: IWindowControllerService): void {
  UNAVAILABLE_CONTROLLERS.add(controller as object);
}

export function isWindowControllerUnavailable(controller: IWindowControllerService): boolean {
  return UNAVAILABLE_CONTROLLERS.has(controller as object);
}

export function buildFallbackScopeParams(scope: ZCodeTaskListWorkspaceScope): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

function toControllerListItem(task: ZCodeTaskMeta): WindowHostControllerTaskListItem {
  return {
    ...task,
    sourceAvailability: "online",
    liveStatus:
      task.status === "running"
        ? "running"
        : task.status === "completed"
          ? "completed"
          : task.status === "error"
            ? "error"
            : "idle",
  };
}

/**
 * 以 tasks-index 持久分区查询替代 windowController 的 listTaskList 投影。
 * 归属（pinned/archived）语义与 controller 行完全同源；回退路径没有 sessions-index
 * activity 与全文检索：activity 由消费方按缺省处理，search 降级为标题包含匹配。
 */
export async function listTaskListViaPartitionRpc(params: {
  zcodeTaskService: Pick<IZCodeTaskService, "listTasks" | "listPinnedTasks" | "listArchivedTasks">;
  query: ZCodeTaskListQuery;
}): Promise<WindowHostControllerTaskListResult> {
  const { query, zcodeTaskService } = params;
  const lists = await Promise.all(
    query.workspaceScopes.map((scope) => {
      const scopeQuery = buildFallbackScopeParams(scope);
      if (query.kind === "pinned") {
        return zcodeTaskService.listPinnedTasks(scopeQuery);
      }
      if (query.kind === "archived") {
        return zcodeTaskService.listArchivedTasks(scopeQuery);
      }
      // timeline 与 active 同义：tasks-index active 分区 = 非 pinned 非 archived。
      return zcodeTaskService.listTasks(scopeQuery);
    }),
  );
  const itemByEntityKey = new Map<string, WindowHostControllerTaskListItem>();
  for (const list of lists) {
    for (const task of list) {
      itemByEntityKey.set(buildTaskEntityKey(task), toControllerListItem(task));
    }
  }
  let items = [...itemByEntityKey.values()];
  const search = query.search?.trim().toLowerCase();
  if (search) {
    items = items.filter((task) => task.title.toLowerCase().includes(search));
  }
  items.sort((left, right) => compareZCodeTaskListItems(left, right, query.sortBy));
  const total = items.length;
  const visible = query.limit == null ? items : items.slice(0, query.limit);
  return { items: visible, total, hasMore: total > visible.length };
}

const FALLBACK_REFRESH_DEBOUNCE_MS = 1500;

const IMMEDIATE_REFRESH_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  // 归属类：决定 pinned/archived/timeline 三类列表的成员关系。
  "task_pinned",
  "task_unpinned",
  "task_archived",
  "task_unarchived",
  "auto_archive",
  // 行集合与展示字段变更：低频事件，直接重查保证回退列表与 tasks-index 对齐。
  "task_created",
  "task_deleted",
  "task_meta_changed",
  "task_status_changed",
  "task_model_changed",
  "task_title_changed",
]);

const DEBOUNCED_REFRESH_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  // 消息流事件只推进 updatedAt（影响排序与相对时间），高频到达；合并成尾沿重查。
  "user_message_saved",
  "assistant_message_saved",
]);

/**
 * 回退路径的事件刷新策略：返回本次事件应延迟多少毫秒后重查，null 表示忽略。
 * controller 路径由 frame 增量驱动；回退路径没有 frame，只能按 workspace 事件选择性重查。
 */
export function getFallbackTaskListRefreshDelayMs(
  reason: ZCodeWorkspaceTaskListChanged["reason"],
): number | null {
  if (IMMEDIATE_REFRESH_REASONS.has(reason)) {
    return 0;
  }
  if (DEBOUNCED_REFRESH_REASONS.has(reason)) {
    return FALLBACK_REFRESH_DEBOUNCE_MS;
  }
  // realtime_sync / stream_mirror_* 等协议层事件不改变 tasks-index 行集合，忽略。
  return null;
}
