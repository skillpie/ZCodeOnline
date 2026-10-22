import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { readDataSourceSelectionRecent } from "@/lib/dataSourceSelectionRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
  projectId?: string | null,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  // 跨会话记忆（specs/data-source.md §7.1，按项目记忆）：草稿自身意图优先，其次恢复该
  // 项目上一次显式选择/取消的结果；null（取消或无记忆）回到缺省未选择态。
  const lastDataSourceId = readDataSourceSelectionRecent(
    workspacePath,
    workspaceIdentity,
    projectId,
  );
  return {
    ...draft,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
    dataSourceId: draft.dataSourceId ?? lastDataSourceId ?? undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}

/**
 * fork ACK 接纳后、切到 child session 前调用（specs/data-source.md §7.1 fork 继承）。
 * 数据源绑定是纯 renderer 状态，CLI forkAssistant 不感知；child 是全新 scope，
 * 不播种会按空草稿初始化丢掉父会话的选择。只带 dataSourceId：mode/modelSelection
 * 由 child 会话自身投影初始化，正文与父草稿其余意图不继承。
 */
export function seedForkedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  parentSessionId: string;
  childSessionId: string;
}): void {
  const { workspacePath, workspaceIdentity, parentSessionId, childSessionId } = result;
  const targetSessionId = childSessionId.trim();
  if (!targetSessionId) return;
  // child 由 CLI 新建，正常无既有草稿；已有（异常重放）时不覆盖。
  if (readV4ComposerDraft(workspacePath, workspaceIdentity, targetSessionId)) return;
  const parent = readV4ComposerDraft(workspacePath, workspaceIdentity, parentSessionId);
  if (!parent?.dataSourceId) return;
  persistV4ComposerDraft(workspacePath, workspaceIdentity, targetSessionId, {
    text: "",
    dataSourceId: parent.dataSourceId,
  });
}
