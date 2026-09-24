/**
 * 数据源 store —— Host 端 IDataSourceService 的 UI 投影缓存。
 *
 * 只作投影：不持久化、不持有第二事实；动作通过 hook 注入的 service 发 RPC。
 * 状态范围：数据源列表、激活 id、每个源的表结构快照与同步状态。
 */
import { create } from "zustand";
import type {
  DataSourceInput,
  DataSourceMutationResult,
  DataSourceSchemaSnapshot,
  DataSourceView,
} from "@zcode/shared";
import type { IDataSourceService } from "@zcode/services";

export type DataSourceSyncStatus = "idle" | "syncing" | "error";

interface DataSourceStoreState {
  loaded: boolean;
  loading: boolean;
  dataSources: DataSourceView[];
  activeId: string | null;
  /** 数据源 id → 最近一次同步的快照（未同步过为 null） */
  snapshots: Record<string, DataSourceSchemaSnapshot | null>;
  syncStatus: Record<string, DataSourceSyncStatus>;
  syncError: Record<string, string | null>;
}

interface DataSourceStoreActions {
  load(service: IDataSourceService): Promise<void>;
  save(service: IDataSourceService, input: DataSourceInput): Promise<DataSourceMutationResult>;
  remove(service: IDataSourceService, id: string): Promise<void>;
  activate(service: IDataSourceService, id: string): Promise<DataSourceMutationResult>;
  resync(service: IDataSourceService, id: string): Promise<DataSourceMutationResult>;
  test(service: IDataSourceService, input: DataSourceInput): Promise<DataSourceTestOutcome>;
  /** 打开管理面板时补拉某个源的快照（不触发内省）。 */
  ensureSnapshot(service: IDataSourceService, id: string): Promise<void>;
}

export type DataSourceStore = DataSourceStoreState & DataSourceStoreActions;

/** 测试结果直接回给表单，不进全局 store。 */
export type DataSourceTestOutcome =
  | { ok: true; version: string }
  | { ok: false; error: string }
  | { ok: false; error: null }; // error=null 表示本地校验失败外的调用异常，由调用方兜底展示

function applyMutationResult(
  state: DataSourceStoreState,
  result: DataSourceMutationResult,
): Partial<DataSourceStoreState> {
  const exists = state.dataSources.some((item) => item.id === result.dataSource.id);
  const dataSources = exists
    ? state.dataSources.map((item) =>
        item.id === result.dataSource.id ? result.dataSource : item,
      )
    : [...state.dataSources, result.dataSource];
  return {
    dataSources,
    activeId: result.activeId,
    snapshots: { ...state.snapshots, [result.dataSource.id]: result.schema },
    syncStatus: { ...state.syncStatus, [result.dataSource.id]: result.syncError ? "error" : "idle" },
    syncError: { ...state.syncError, [result.dataSource.id]: result.syncError },
  };
}

export const useDataSourceStore = create<DataSourceStore>((set, get) => ({
  loaded: false,
  loading: false,
  dataSources: [],
  activeId: null,
  snapshots: {},
  syncStatus: {},
  syncError: {},

  async load(service) {
    set({ loading: true });
    try {
      const result = await service.listDataSources();
      set({
        loaded: true,
        loading: false,
        dataSources: result.dataSources,
        activeId: result.activeId,
      });
    } catch {
      set({ loading: false });
    }
  },

  async save(service, input) {
    const result = await service.saveDataSource(input);
    set((state) => applyMutationResult(state, result));
    return result;
  },

  async remove(service, id) {
    await service.deleteDataSource(id);
    set((state) => {
      const snapshots = { ...state.snapshots };
      const syncStatus = { ...state.syncStatus };
      const syncError = { ...state.syncError };
      delete snapshots[id];
      delete syncStatus[id];
      delete syncError[id];
      return {
        dataSources: state.dataSources.filter((item) => item.id !== id),
        activeId: state.activeId === id ? null : state.activeId,
        snapshots,
        syncStatus,
        syncError,
      };
    });
  },

  async activate(service, id) {
    set((state) => ({ syncStatus: { ...state.syncStatus, [id]: "syncing" } }));
    try {
      const result = await service.activateDataSource(id);
      set((state) => applyMutationResult(state, result));
      return result;
    } catch (error) {
      set((state) => ({
        syncStatus: { ...state.syncStatus, [id]: "error" },
        syncError: {
          ...state.syncError,
          [id]: error instanceof Error ? error.message : String(error),
        },
      }));
      throw error;
    }
  },

  async resync(service, id) {
    set((state) => ({ syncStatus: { ...state.syncStatus, [id]: "syncing" } }));
    try {
      const result = await service.syncSchema(id);
      set((state) => applyMutationResult(state, result));
      return result;
    } catch (error) {
      set((state) => ({
        syncStatus: { ...state.syncStatus, [id]: "error" },
        syncError: {
          ...state.syncError,
          [id]: error instanceof Error ? error.message : String(error),
        },
      }));
      throw error;
    }
  },

  async test(service, input) {
    try {
      return await service.testDataSource(input);
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async ensureSnapshot(service, id) {
    if (get().snapshots[id] !== undefined) return;
    try {
      const snapshot = await service.getSchemaSnapshot(id);
      set((state) => ({ snapshots: { ...state.snapshots, [id]: snapshot } }));
    } catch {
      set((state) => ({ snapshots: { ...state.snapshots, [id]: null } }));
    }
  },
}));

export function selectActiveDataSource(state: DataSourceStoreState): DataSourceView | null {
  return state.dataSources.find((item) => item.id === state.activeId) ?? null;
}
