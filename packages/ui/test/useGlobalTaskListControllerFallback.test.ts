// window-controller 通道缺失时的分区查询回退：daemon 等网页会话宿主不注册
// IWindowControllerService，controller 调用统一以 "Unknown channel" 超时失败。
// 验证回退数据源接线、通道缺失标记的跨 load 复用，以及 workspace 事件驱动的刷新策略。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor, ZCodeTaskListKind } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import {
  getFallbackTaskListRefreshDelayMs,
  isWindowControllerChannelMissingError,
  listTaskListViaPartitionRpc,
} from "@/lib/taskListControllerFallback.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

function createChannelMissingError(): Error {
  // 与 rpc/channelClient 还原 ChannelServer PromiseError 的形态一致。
  const error = new Error("Channel name 'window-controller' timed out after 1000ms");
  error.name = "Unknown channel";
  return error;
}

describe("taskListControllerFallback", () => {
  describe("isWindowControllerChannelMissingError", () => {
    it("识别 Unknown channel 错误，放过其他错误", () => {
      expect(isWindowControllerChannelMissingError(createChannelMissingError())).toBe(true);
      expect(isWindowControllerChannelMissingError(new Error("rpc failed"))).toBe(false);
      expect(isWindowControllerChannelMissingError(null)).toBe(false);
    });
  });

  describe("getFallbackTaskListRefreshDelayMs", () => {
    it("归属/行集合事件立即重查，消息流事件尾沿去抖，协议事件忽略", () => {
      expect(getFallbackTaskListRefreshDelayMs("task_pinned")).toBe(0);
      expect(getFallbackTaskListRefreshDelayMs("task_deleted")).toBe(0);
      expect(getFallbackTaskListRefreshDelayMs("task_meta_changed")).toBe(0);
      expect(getFallbackTaskListRefreshDelayMs("user_message_saved")).toBeGreaterThan(0);
      expect(getFallbackTaskListRefreshDelayMs("assistant_message_saved")).toBeGreaterThan(0);
      expect(getFallbackTaskListRefreshDelayMs("stream_mirror_gap")).toBeNull();
      expect(getFallbackTaskListRefreshDelayMs("realtime_sync")).toBeNull();
    });
  });

  describe("listTaskListViaPartitionRpc", () => {
    function createPartitionService() {
      return {
        listTasks: vi.fn(async () => [
          createTaskMeta({ taskId: "t-active", updatedAt: 30, status: "running" }),
        ]),
        listPinnedTasks: vi.fn(async () => [
          createTaskMeta({ taskId: "t-pin-2", updatedAt: 20 }),
          createTaskMeta({ taskId: "t-pin-1", updatedAt: 40 }),
        ]),
        listArchivedTasks: vi.fn(async () => [createTaskMeta({ taskId: "t-arch", updatedAt: 5 })]),
      };
    }

    it("pinned/archived/timeline 分别命中对应分区查询并按 updated 倒序输出", async () => {
      const zcodeTaskService = createPartitionService();
      const pinned = await listTaskListViaPartitionRpc({
        zcodeTaskService,
        query: {
          kind: "pinned",
          workspaceScopes: [{ workspacePath: "/ws" }],
          sortBy: "updated",
        },
      });
      expect(zcodeTaskService.listPinnedTasks).toHaveBeenCalled();
      expect(pinned.items.map((task) => task.taskId)).toEqual(["t-pin-1", "t-pin-2"]);
      expect(pinned.total).toBe(2);
      expect(pinned.hasMore).toBe(false);

      const timeline = await listTaskListViaPartitionRpc({
        zcodeTaskService,
        query: {
          kind: "timeline",
          workspaceScopes: [{ workspacePath: "/ws" }],
          sortBy: "updated",
        },
      });
      expect(zcodeTaskService.listTasks).toHaveBeenCalled();
      expect(timeline.items.map((task) => task.taskId)).toEqual(["t-active"]);

      const archived = await listTaskListViaPartitionRpc({
        zcodeTaskService,
        query: {
          kind: "archived",
          workspaceScopes: [{ workspacePath: "/ws" }],
          sortBy: "updated",
        },
      });
      expect(zcodeTaskService.listArchivedTasks).toHaveBeenCalled();
      expect(archived.items.map((task) => task.taskId)).toEqual(["t-arch"]);
    });

    it("limit 生效且 total/hasMore 反映截断前数量", async () => {
      const zcodeTaskService = createPartitionService();
      const result = await listTaskListViaPartitionRpc({
        zcodeTaskService,
        query: {
          kind: "pinned",
          workspaceScopes: [{ workspacePath: "/ws" }],
          sortBy: "updated",
          limit: 1,
        },
      });
      expect(result.items.map((task) => task.taskId)).toEqual(["t-pin-1"]);
      expect(result.total).toBe(2);
      expect(result.hasMore).toBe(true);
    });

    it("search 降级为标题包含匹配", async () => {
      const zcodeTaskService = createPartitionService();
      (zcodeTaskService.listPinnedTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        createTaskMeta({ taskId: "t-hit", title: "Fix login bug", updatedAt: 2 }),
        createTaskMeta({ taskId: "t-miss", title: "别的任务", updatedAt: 3 }),
      ]);
      const result = await listTaskListViaPartitionRpc({
        zcodeTaskService,
        query: {
          kind: "pinned",
          workspaceScopes: [{ workspacePath: "/ws" }],
          sortBy: "updated",
          search: "LOGIN",
        },
      });
      expect(result.items.map((task) => task.taskId)).toEqual(["t-hit"]);
      expect(result.total).toBe(1);
    });

    it("跨 scope 去重并携带 workspace 归属字段与回退行字段", async () => {
      const zcodeTaskService = createPartitionService();
      (zcodeTaskService.listTasks as ReturnType<typeof vi.fn>).mockImplementation(
        async (params: { workspacePath: string }) => [
          createTaskMeta({
            taskId: "t-shared",
            workspacePath: params.workspacePath,
            status: "completed",
          }),
        ],
      );
      const result = await listTaskListViaPartitionRpc({
        zcodeTaskService,
        query: {
          kind: "timeline",
          workspaceScopes: [{ workspacePath: "/ws-a" }, { workspacePath: "/ws-b" }],
          sortBy: "updated",
        },
      });
      expect(result.items).toHaveLength(2);
      for (const item of result.items) {
        expect(item.sourceAvailability).toBe("online");
        expect(item.liveStatus).toBe("completed");
      }
      expect(new Set(result.items.map((task) => task.workspacePath))).toEqual(
        new Set(["/ws-a", "/ws-b"]),
      );
    });
  });
});

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    taskId: "t-1",
    title: "Task 1",
    traceId: "trace-t-1",
    updatedAt: 2,
    workspacePath: "/ws",
    ...overrides,
  } as ZCodeTaskMeta;
}

function createWorkspaceTab(): WorkspaceTabState {
  return {
    id: "workspace-1",
    kind: "workspace",
    label: "workspace",
    workspacePath: "/workspace",
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface FallbackHarnessOptions {
  kind: ZCodeTaskListKind;
  tasks?: ZCodeTaskMeta[];
}

async function renderFallbackHarness(options: FallbackHarnessOptions) {
  const controllerListTaskList = vi.fn(async () => {
    throw createChannelMissingError();
  });
  const tasks = options.tasks ?? [
    createTaskMeta({ taskId: "t-1", title: "Task 1", updatedAt: 2 }),
    createTaskMeta({ taskId: "t-2", title: "Task 2", updatedAt: 3 }),
  ];
  const listTasks = vi.fn(async () =>
    options.kind === "pinned" || options.kind === "archived" ? [] : tasks,
  );
  const listPinnedTasks = vi.fn(async () => (options.kind === "pinned" ? tasks : []));
  const listArchivedTasks = vi.fn(async () => (options.kind === "archived" ? tasks : []));
  const workspaceEventListeners: Array<
    (event: {
      type: string;
      workspacePath: string;
      reason: ZCodeWorkspaceTaskListChanged["reason"];
    }) => void
  > = [];
  const controllerFrames = new Emitter<never>();
  const services = {
    windowControllerService: {
      listTaskList: controllerListTaskList,
      mutateTask: vi.fn(async () => null),
      subscribeControllerV4: vi.fn(async ({ topic }: { topic: string }) => ({
        ack: { subscriptionId: `sub-${topic}`, mode: "snapshot" as const, logEpoch: "e1" },
      })),
      resyncControllerV4: vi.fn(async ({ subscriptionId }: { subscriptionId: string }) => ({
        ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "e1" },
      })),
      unsubscribeControllerV4: vi.fn(async () => {}),
      onDynamicControllerFrame: () => controllerFrames.event,
    },
    zcodeTaskService: {
      listTaskList: vi.fn(async () => ({ items: [], total: 0, hasMore: false })),
      listPinnedTaskIds: vi.fn(async () => []),
      listArchivedTasks,
      listTasks,
      listPinnedTasks,
      onDynamicWorkspaceEvent: () => (listener: (typeof workspaceEventListeners)[number]) => {
        workspaceEventListeners.push(listener);
        return { dispose() {} };
      },
    },
  } as unknown as IServiceAccessor;
  const workspaceTabs = [createWorkspaceTab()];
  let latest: ReturnType<typeof useGlobalTaskList> | null = null;

  function Probe() {
    latest = useGlobalTaskList({
      collapsedLimit: 5,
      expanded: false,
      kind: options.kind,
      searchQuery: "",
      sortBy: "updated",
      workspaceTabs,
    });
    return null;
  }

  const root: Root = createRoot(installMinimalDom());
  await act(async () => {
    root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
    await flushMicrotasks();
  });
  await act(async () => {
    await flushMicrotasks();
  });
  return {
    getItems: () => latest?.items ?? [],
    getLoading: () => latest?.loading ?? false,
    controllerListTaskList,
    listTasks,
    listPinnedTasks,
    listArchivedTasks,
    emitWorkspaceEvent: (reason: ZCodeWorkspaceTaskListChanged["reason"]) =>
      act(async () => {
        for (const listener of workspaceEventListeners) {
          listener({ type: "workspace_task_list_changed", workspacePath: "/workspace", reason });
        }
        await flushMicrotasks();
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

describe("useGlobalTaskList controller fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    useTaskQueryCacheStore.getState().clearAll();
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: {},
    });
    useZCodeSessionStore.setState({ workspaces: {} });
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("controller 通道缺失时回退分区查询并渲染列表", async () => {
    const harness = await renderFallbackHarness({ kind: "timeline" });
    expect(harness.controllerListTaskList).toHaveBeenCalledTimes(1);
    expect(harness.listTasks).toHaveBeenCalled();
    expect(harness.getItems().map((task) => task.taskId)).toEqual(["t-2", "t-1"]);
    await harness.unmount();
  });

  it("通道缺失被标记后，后续 load 不再重试 controller", async () => {
    const harness = await renderFallbackHarness({ kind: "timeline" });
    const callsAfterFirstLoad = harness.controllerListTaskList.mock.calls.length;
    await harness.emitWorkspaceEvent("task_pinned");
    expect(harness.controllerListTaskList.mock.calls.length).toBe(callsAfterFirstLoad);
    expect(harness.listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    await harness.unmount();
  });

  it("归属事件立即触发重查，消息流事件按尾沿去抖", async () => {
    const harness = await renderFallbackHarness({ kind: "timeline" });
    const callsBefore = harness.listTasks.mock.calls.length;

    await harness.emitWorkspaceEvent("task_pinned");
    expect(harness.listTasks.mock.calls.length).toBe(callsBefore + 1);

    await harness.emitWorkspaceEvent("user_message_saved");
    expect(harness.listTasks.mock.calls.length).toBe(callsBefore + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(harness.listTasks.mock.calls.length).toBe(callsBefore + 2);

    await harness.emitWorkspaceEvent("stream_mirror_gap");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(harness.listTasks.mock.calls.length).toBe(callsBefore + 2);
    await harness.unmount();
  });

  it("pinned 回退列表使用 listPinnedTasks 数据源", async () => {
    const harness = await renderFallbackHarness({
      kind: "pinned",
      tasks: [createTaskMeta({ taskId: "t-pin", title: "Pinned", updatedAt: 4 })],
    });
    expect(harness.listPinnedTasks).toHaveBeenCalled();
    expect(harness.getItems().map((task) => task.taskId)).toEqual(["t-pin"]);
    await harness.unmount();
  });
});
