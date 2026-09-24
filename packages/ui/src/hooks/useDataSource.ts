/**
 * useDataSource —— 数据源管理 hooks（组件经此访问 IDataSourceService，不直触 RPC）。
 * service 缺失（旧 host / 无 provider 宿主）时 available=false，UI 据此隐藏入口。
 * 注意：zustand 动作用独立选择器取（引用稳定）；不能整 store 解构，否则每次 set
 * 都换引用导致 effect 重跑。
 */
import { useCallback, useEffect } from "react";
import type { DataSourceInput, DataSourceMutationResult } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  selectActiveDataSource,
  useDataSourceStore,
  type DataSourceTestOutcome,
} from "@/store/dataSourceStore.js";

const selectLoading = (state: { loading: boolean }) => state.loading;

export function useDataSourceManager() {
  const { dataSourceService: service } = useServices();
  const dataSources = useDataSourceStore((state) => state.dataSources);
  const activeId = useDataSourceStore((state) => state.activeId);
  const activeDataSource = useDataSourceStore(selectActiveDataSource);
  const snapshots = useDataSourceStore((state) => state.snapshots);
  const syncStatus = useDataSourceStore((state) => state.syncStatus);
  const syncError = useDataSourceStore((state) => state.syncError);
  const loading = useDataSourceStore(selectLoading);
  const loadAction = useDataSourceStore((state) => state.load);
  const saveAction = useDataSourceStore((state) => state.save);
  const removeAction = useDataSourceStore((state) => state.remove);
  const activateAction = useDataSourceStore((state) => state.activate);
  const resyncAction = useDataSourceStore((state) => state.resync);
  const testAction = useDataSourceStore((state) => state.test);
  const ensureSnapshotAction = useDataSourceStore((state) => state.ensureSnapshot);

  useEffect(() => {
    if (!service) return;
    void loadAction(service);
  }, [service, loadAction]);

  const load = useCallback(async () => {
    if (service) await loadAction(service);
  }, [service, loadAction]);

  const save = useCallback(
    async (input: DataSourceInput): Promise<DataSourceMutationResult> => {
      if (!service) throw new Error("数据源服务不可用");
      return saveAction(service, input);
    },
    [service, saveAction],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!service) throw new Error("数据源服务不可用");
      await removeAction(service, id);
    },
    [service, removeAction],
  );

  const activate = useCallback(
    async (id: string): Promise<DataSourceMutationResult> => {
      if (!service) throw new Error("数据源服务不可用");
      return activateAction(service, id);
    },
    [service, activateAction],
  );

  const resync = useCallback(
    async (id: string): Promise<DataSourceMutationResult> => {
      if (!service) throw new Error("数据源服务不可用");
      return resyncAction(service, id);
    },
    [service, resyncAction],
  );

  const test = useCallback(
    async (input: DataSourceInput): Promise<DataSourceTestOutcome> => {
      if (!service) return { ok: false, error: null };
      return testAction(service, input);
    },
    [service, testAction],
  );

  const ensureSnapshot = useCallback(
    async (id: string) => {
      if (service) await ensureSnapshotAction(service, id);
    },
    [service, ensureSnapshotAction],
  );

  return {
    available: service !== undefined,
    dataSources,
    activeId,
    activeDataSource,
    snapshots,
    syncStatus,
    syncError,
    loading,
    load,
    save,
    remove,
    activate,
    resync,
    test,
    ensureSnapshot,
  };
}
