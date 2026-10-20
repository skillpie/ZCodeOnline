import type { IZCodeSessionService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface DeferredDraftRuntimeChangeParams {
  logScope: string;
  reason: string;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  // 用户扩展：旧链路用 zcodeSessionService 关闭 legacy 草稿 session。
  // 官方 sync 移除了 store.draftSessionId（V4 pane 独占预热会话，失效走 invalidateDraftRuntime 版本递增），
  // 这里保留可选参数兼容既有调用方，实际关闭逻辑随 draftSessionId 一起退役。
  zcodeSessionService?: Pick<IZCodeSessionService, "closeSession">;
}

export async function invalidateDeferredDraftSessionForRuntimeChange(
  params: DeferredDraftRuntimeChangeParams,
): Promise<void> {
  if (!params.workspacePath) {
    return;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const store = useZCodeSessionStore.getState();
  // V4 pane 是预热会话的唯一 owner；设置操作只发失效版本，不直接关闭会话。
  store.invalidateDraftRuntime(params.workspacePath, workspaceIdentity);
  logger.info(`[${params.logScope}] invalidated draft runtime capabilities`, {
    reason: params.reason,
    workspaceIdentity: workspaceIdentity ?? null,
    workspacePath: params.workspacePath,
  });
}

export async function invalidateDeferredDraftSessionForSkillChange(
  params: Omit<DeferredDraftRuntimeChangeParams, "logScope">,
): Promise<void> {
  await invalidateDeferredDraftSessionForRuntimeChange({ ...params, logScope: "skills" });
}
