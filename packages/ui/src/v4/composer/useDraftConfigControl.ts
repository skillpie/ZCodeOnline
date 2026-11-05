/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// 当前编辑由 Composer 持有；进入已有 Session 从当前快照恢复权限/Plan，在线只响应新变化。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import { applyComposerModeSwitch } from "@/v4/composer/composerModeSwitch.js";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { writeDataSourceSelectionRecent } from "@/lib/dataSourceSelectionRecent.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import {
  readSessionDataSourceBinding,
  writeSessionDataSourceBinding,
} from "@/v4/composer/sessionDataSourceBinding.js";
import { useServices } from "@/hooks/useServices.js";
import { resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { resolveComposerScope, composerScopeKey } from "@/v4/composer/composerDraftStore.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

export function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

export type ComposerDraftContent = Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">;

export interface ComposerSubmissionDraftTransactionResult {
  current: boolean;
  applied: boolean;
}

export interface ComposerSubmissionDraftTransaction {
  claim: () => boolean;
  restore: () => ComposerSubmissionDraftTransactionResult;
  finalize: () => ComposerSubmissionDraftTransactionResult | null;
  release: () => void;
  matchesTarget: (scopeToken: symbol) => boolean;
}

export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；恢复采用当前权限，在线授权只同步对应字段。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿全量（含会话级数据源绑定）；发送冻结时按 ref 读取，不依赖重渲染。 */
  composerDraftRef: React.RefObject<V4ComposerDraft>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  /** 当前 scope incarnation；Root promotion 沿用同一 token，离开再返回会生成新 token。 */
  composerDraftScopeToken: symbol;
  /** 输入热路径只暂存正文，不触发父级 render 或 localStorage。 */
  stageComposerContent: (content: ComposerDraftContent) => void;
  /** 为 effect setup 捕获一次性生命周期收口；切换后仍只写回该 scope incarnation。 */
  captureComposerContentLifecycleCommit: () => (content: ComposerDraftContent) => void;
  /** 发送事务绑定提交时的 scope；失败恢复和成功结算都不能写入后来切换的 scope。 */
  captureComposerSubmissionDraftTransaction: (
    content: ComposerDraftContent,
  ) => ComposerSubmissionDraftTransaction;
  /** 普通保存只落盘已有正文缓冲，不发布整页配置更新。 */
  persistComposerContent: (content: ComposerDraftContent) => void;
  updateComposerContent: (content: ComposerDraftContent) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => boolean;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
  /** 会话级数据源选择（specs/data-source.md §7）；null = 恢复未选择。选择/取消都写入 workspace 记忆。 */
  handleDraftSelectDataSource: (dataSourceId: string | null) => void;
  /** 预热身份就绪后观察所属草稿的新授权，不改变 Composer 的 root scope。 */
  observeDraftPermissionGrant: (
    sourceSessionId: string,
    config: Partial<SessionConfigState>,
  ) => void;
}

interface ComposerDraftPersistenceTarget {
  scopeKey: string;
  incarnation: symbol;
  contentRevision: { current: number };
  baseDraft: V4ComposerDraft;
  persist: (draft: V4ComposerDraft) => boolean;
}

interface ComposerState {
  scopeKey: string;
  incarnation: symbol;
  workspaceKey: string;
  draft: V4ComposerDraft;
  initialization: "new-task" | "session" | "promotion";
  observedConfig?: {
    sourceSessionId?: string;
    permissionGrantId?: string;
    planTransitionId?: string;
  };
  promotedSessionId?: string;
}

function hasSameComposerDraftContent(left: V4ComposerDraft, right: V4ComposerDraft): boolean {
  return (
    left.text === right.text &&
    left.editorStateJson === right.editorStateJson &&
    left.mention === right.mention
  );
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** 会话切换恢复文字/模型，权限和 Plan 使用当前快照。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const { dataSourceService } = useServices();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const clientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  // Bugfix：数据源按项目记忆的归属不能用 draftProjectId——运行中会话的 follow-up
  // composer 里它是 undefined，选择会落到 workspace 桶、项目桶留存陈旧选择，恢复即旧值。
  // 这里改为按目录从 Provider 持有的项目树同步解析（与草稿桶同源）；解析不到再回退
  // draftProjectId，最终回退 workspace 记忆。
  const projectDirectory = useOptionalProjectDirectory();
  const workspaceProjectId = useMemo(() => {
    const byRoot = projectDirectory?.tree.projects.find((project) =>
      project.roots.some((root) => root.rootPath === workspacePath),
    )?.id;
    return byRoot ?? draftProjectId ?? null;
  }, [projectDirectory, workspacePath, draftProjectId]);
  const rootScope = useMemo(
    () => resolveComposerScope(draftProjectId, workspaceIdentity, clientNamespace),
    [draftProjectId, workspaceIdentity, clientNamespace],
  );
  const draftFocusVersion = useZCodeSessionStore((state) =>
    sessionId === null ? (state.workspaces[workspaceKey]?.draftFocusVersion ?? 0) : 0,
  );
  // New Task 可以复用同一个 pane；无文字时必须重新取 Recent，不能只清磁盘留旧内存。
  const scopeKey = JSON.stringify([
    workspaceKey,
    scopeId,
    draftFocusVersion,
    sessionId === null ? composerScopeKey(rootScope) : null,
  ]);
  const navigationInitialization = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace?.activeTaskId === sessionId &&
      workspace?.composerInitialization?.taskId === sessionId
      ? workspace.composerInitialization
      : undefined;
  });
  const loadedScope = useMemo<ComposerState>(() => {
    const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, rootScope);
    return {
      scopeKey,
      incarnation: Symbol(scopeKey),
      workspaceKey,
      draft: saved ?? { text: "", updatedAt: 0, ...navigationInitialization?.config },
      initialization:
        sessionId === null || (!saved && navigationInitialization) ? "new-task" : "session",
    };
  }, [scopeKey]);
  const [storedState, setStoredState] = useState(loadedScope);
  // 用户决策：真实会话的数据源绑定以宿主侧会话 map 为准（草稿生命周期会反复冲掉
  // 绑定）；未绑定时不动草稿，由 new-task 初始化回退项目级记忆。读宿主绑定回填的
  // effect 定义在 stateRef 之后（回填基于 stateRef.current 构造，见下方注释）。
  const sessionBindingScopeKey = scopeKey;
  const [, forceBindingSeed] = useState(0);
  const stagedContentRef = useRef<
    | (ComposerDraftPersistenceTarget & {
        content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">;
      })
    | null
  >(null);
  // 首发是同一 pane 的地址迁移，保持其间的新编辑；换页或卸载不保留第二份配置。
  let currentState: ComposerState =
    storedState.scopeKey === scopeKey
      ? storedState
      : storedState.workspaceKey === workspaceKey && storedState.promotedSessionId === sessionId
        ? {
            ...storedState,
            scopeKey,
            // Root→session promotion 是同一 pane 的地址迁移；发送事务必须沿用同一 incarnation。
            incarnation: storedState.incarnation,
            initialization: "promotion",
            observedConfig: undefined,
            promotedSessionId: undefined,
          }
        : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  if (currentState.initialization === "new-task" && !draft.mode && modelSelectionView) {
    draft = initializeNewTaskDraft(
      draft,
      workspacePath,
      workspaceIdentity,
      modelSelectionView,
      rootScope,
      workspaceProjectId,
    );
  }
  // 空配置先初始化了权限，旧逻辑便因已有 mode 永久跳过模型初始化。
  // 仅为无模型原意图的 Root 草稿补齐首次可用选择；不重置正文、权限或 Plan，
  // 也不替换失效的旧选择、已有 Session 或分享导入的配置。
  if (sessionId === null && !draft.modelSelection && modelSelectionView) {
    const selection = resolveDraftInitialModelSelection(modelSelectionView, null).selection;
    if (selection) draft = { ...draft, modelSelection: selection };
  }
  if (sessionId && sessionConfig) {
    const previous = currentState.observedConfig;
    const observedConfig = {
      permissionGrantId: sessionConfig.permissionGrant?.interactionId,
      planTransitionId: sessionConfig.planTransition?.toolCallId,
    };
    const firstSnapshot = !previous;
    const mode = submissionModeSchema.safeParse(sessionConfig.mode);
    const currentMode = mode.success && mode.data !== "plan" ? mode.data : "build";
    const currentPlan = resolveExecutionState(sessionConfig).planEnabled;
    if (firstSnapshot && currentState.initialization === "session") {
      // 历史授权曾被当成新指令重放，覆盖最新确认模式。恢复直接采用当前事实，文字只恢复模型。
      draft = {
        ...draft,
        mode: currentMode,
        planEnabled: currentPlan,
        modelSelection: draft.mode ? draft.modelSelection : sessionConfig.modelSelection,
      };
    } else if (previous) {
      // 只处理本次打开后出现的新关联；使用最新快照值，不能从历史事件推导固定 yolo/Plan。
      const permissionChanged =
        observedConfig.permissionGrantId &&
        observedConfig.permissionGrantId !== previous.permissionGrantId;
      const planChanged =
        observedConfig.planTransitionId &&
        observedConfig.planTransitionId !== previous.planTransitionId;
      if (permissionChanged || planChanged)
        draft = {
          ...draft,
          ...(permissionChanged ? { mode: currentMode } : {}),
          ...(planChanged ? { planEnabled: currentPlan } : {}),
        };
    }
    if (
      firstSnapshot ||
      observedConfig.permissionGrantId !== previous.permissionGrantId ||
      observedConfig.planTransitionId !== previous.planTransitionId
    ) {
      currentState = { ...currentState, observedConfig };
    }
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 会话切换/挂载时异步读宿主绑定，回填到当前草稿内存态（不写草稿持久化，避免
  // 又被空白清理冲掉）。
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    void readSessionDataSourceBinding(dataSourceService, sessionId).then((bound) => {
      if (cancelled || !bound) return;
      // Bugfix：回填必须基于 stateRef.current（每渲染同步到最新 scope）构造。此前检查
      // setStoredState 的 current（旧 scope 的 storedState）——Web 端切换会话不重挂载
      // composer 时 storedState 停留在旧 scope，守卫永不满足，宿主绑定读回后被丢弃，
      // 表现为「远端没记住」；桌面端因 composer 重挂载而侥幸正常。
      if (stateRef.current.scopeKey !== sessionBindingScopeKey) return;
      if (stateRef.current.draft.dataSourceId) return;
      const next = {
        ...stateRef.current,
        draft: { ...stateRef.current.draft, dataSourceId: bound },
      };
      stateRef.current = next;
      setStoredState(next);
      forceBindingSeed((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [dataSourceService, sessionId, sessionBindingScopeKey]);
  // 与 stateRef 同步的草稿快照；发送冻结路径读 .current（与 draftConfigRef 同一模式）。
  const composerDraftRef = useRef(draft);
  composerDraftRef.current = draft;
  // 原因：按 revision 清草稿会把短暂不可用永久写成空选择。这里只派生当前结果，
  // 正文/模式自动保存继续保存 draft 中的原意图；读取未就绪时保留展示，提交由 View 门禁阻断。
  // 已有会话首份配置未恢复时，null selection 的 View 只是新任务默认值，不能显示到此会话。
  const sessionConfigPending = sessionId !== null && !currentState.observedConfig;
  const effectiveSelection =
    modelSelectionView && !sessionConfigPending
      ? (modelSelectionView.effectiveSelection ?? undefined)
      : draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode:
        currentState.initialization === "session" && !currentState.observedConfig
          ? undefined
          : draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [
      draft.mode,
      draft.planEnabled,
      effectiveSelection,
      currentState.initialization,
      currentState.observedConfig,
    ],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  // 把「下一次提交」的模型意图发布到 workspace store（setComposerModelSelection 内部按
  // provider/model/档位去重）。提交前 Host 会话文件不更新该意图，Git 提交消息生成等
  // 非 composer 入口（GitActionMenu）从这里读取当前会话的有效选择；多 pane 并存时后发布者覆盖先发布者。
  useEffect(() => {
    useZCodeSessionStore
      .getState()
      .setComposerModelSelection(workspacePath, effectiveSelection ?? null, workspaceIdentity);
  }, [effectiveSelection, workspaceIdentity, workspacePath]);
  const createDraftPersistence = useCallback(
    (targetScopeId = stateRef.current.promotedSessionId ?? scopeId) => {
      const workspace = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      return (value: V4ComposerDraft) => {
        const current = useZCodeSessionStore
          .getState()
          .getWorkspaceState(workspacePath, workspaceIdentity);
        // Bug 根因：自动保存不再触发父级 render 后，旧闭包可能把已关闭的分组归属写回来。
        // 同一草稿从唯一 owner 读取最新意图；新草稿/项目已接管时仍冻结原 scope 的归属。
        const placement =
          current.draftFocusVersion === workspace.draftFocusVersion &&
          current.draftProjectId === workspace.draftProjectId
            ? current
            : workspace;
        return persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          targetScopeId,
          scopeId === V4_DRAFT_SCOPE_ROOT
            ? {
                ...value,
                projectId:
                  placement.draftProjectId !== undefined
                    ? placement.draftProjectId
                    : value.projectId,
                // undefined 是显式撤销分组，不能回退到旧正文快照中的 taskGroupId。
                taskGroupId: placement.draftTaskGroupId,
              }
            : value,
          rootScope,
        );
      };
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope],
  );
  const draftPersistence = createDraftPersistence();
  const draftPersistenceRef = useRef(draftPersistence);
  draftPersistenceRef.current = draftPersistence;
  const incarnation = currentState.incarnation;
  const scopeContentRevisionRef = useRef(new Map<string, { current: number }>());
  const promotedRevisionSourceKey =
    currentState.initialization === "promotion" && storedState.scopeKey !== scopeKey
      ? storedState.scopeKey
      : scopeKey;
  const scopePersistenceTarget = useMemo<ComposerDraftPersistenceTarget>(() => {
    const contentRevision = scopeContentRevisionRef.current.get(promotedRevisionSourceKey) ?? {
      current: 0,
    };
    scopeContentRevisionRef.current.set(scopeKey, contentRevision);
    return {
      scopeKey,
      incarnation,
      contentRevision,
      baseDraft: stateRef.current.draft,
      persist: createDraftPersistence(),
    };
  }, [createDraftPersistence, incarnation, promotedRevisionSourceKey, scopeKey]);
  const bumpScopeContentRevision = useCallback((target: ComposerDraftPersistenceTarget) => {
    target.contentRevision.current += 1;
  }, []);
  const persistDraft = useCallback(
    (value: V4ComposerDraft) => draftPersistenceRef.current(value),
    [],
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (navigationInitialization)
      useZCodeSessionStore
        .getState()
        .consumeComposerInitialization(workspacePath, navigationInitialization, workspaceIdentity);
  }, [scopeKey, navigationInitialization, workspacePath, workspaceIdentity]);
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      stateRef.current.incarnation === incarnation &&
      (sessionId !== null ||
        (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion ?? 0) === draftFocusVersion),
    [scopeKey, incarnation, sessionId, workspacePath, workspaceIdentity, draftFocusVersion],
  );
  const mergeStagedContent = useCallback(
    (current: V4ComposerDraft): V4ComposerDraft => {
      const staged = stagedContentRef.current;
      if (!staged || staged.scopeKey !== scopeKey) return current;
      return {
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...staged.content,
      };
    },
    [scopeKey],
  );
  useEffect(() => {
    if (!hasSameComposerDraftContent(scopePersistenceTarget.baseDraft, currentState.draft)) {
      bumpScopeContentRevision(scopePersistenceTarget);
    }
    scopePersistenceTarget.baseDraft = currentState.draft;
    scopePersistenceTarget.persist = draftPersistenceRef.current;
    const pending = stagedContentRef.current;
    if (pending?.scopeKey === scopeKey) {
      pending.baseDraft = currentState.draft;
      pending.persist = draftPersistenceRef.current;
    }
  }, [currentState.draft, scopeKey, scopePersistenceTarget]);
  useEffect(
    () => () => {
      const pending = stagedContentRef.current;
      if (!pending || pending.scopeKey !== scopeKey) return;
      pending.persist({
        ...pending.baseDraft,
        editorStateJson: undefined,
        mention: undefined,
        ...pending.content,
      });
      stagedContentRef.current = null;
    },
    [scopeKey],
  );
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      draft.mode &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistDraft(mergeStagedContent(draft));
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey, persistDraft, mergeStagedContent]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      const previous = mergeStagedContent(stateRef.current.draft);
      const next = update(previous);
      if (!hasSameComposerDraftContent(previous, next)) {
        bumpScopeContentRevision(scopePersistenceTarget);
      }
      const staged = stagedContentRef.current;
      if (staged?.scopeKey === scopeKey) stagedContentRef.current = null;
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      scopePersistenceTarget.baseDraft = next;
      scopePersistenceTarget.persist = draftPersistenceRef.current;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistDraft(next);
      lastPersistedDraftRef.current = next;
    },
    [isCurrentScope, mergeStagedContent, persistDraft, scopePersistenceTarget],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // 导入等待目录期间的显式选择也是有效选择，不能再被默认初始化覆盖。
        ...(current.mode ? {} : { mode: mode.success ? mode.data : "build" }),
      }));
    },
    [updateComposerDraft],
  );
  const observeDraftPermissionGrant = useCallback(
    (sourceSessionId: string, config: Partial<SessionConfigState>) => {
      if (sessionId !== null || !isCurrentScope() || stateRef.current.promotedSessionId) return;
      const previous = stateRef.current.observedConfig;
      const permissionGrantId = config.permissionGrant?.interactionId;
      if (
        previous?.sourceSessionId === sourceSessionId &&
        previous.permissionGrantId === permissionGrantId
      )
        return;
      const next = { ...stateRef.current, observedConfig: { sourceSessionId, permissionGrantId } };
      stateRef.current = next;
      setStoredState(next);
      // 草稿此前未观察授权，首发会携带旧 mode 撤销完全访问；只消费同一来源的新授权。
      if (previous?.sourceSessionId !== sourceSessionId || !permissionGrantId) return;
      const mode = submissionModeSchema.safeParse(config.mode);
      if (!mode.success || mode.data === "plan") return;
      logger.info("[v4-composer] 草稿同步完全访问授权", {
        sourceSessionId,
        permissionGrantId,
        mode: mode.data,
      });
      updateComposerDraft((current) => ({ ...current, mode: mode.data }));
    },
    [sessionId, isCurrentScope, updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const stageComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      // scopeKey 会在 A₁→B→A₂ 后复用；旧输入回调必须同时校验本次挂载身份。
      if (!isCurrentScope()) return;
      stagedContentRef.current = {
        scopeKey,
        incarnation,
        contentRevision: scopePersistenceTarget.contentRevision,
        content,
        baseDraft: stateRef.current.draft,
        persist: draftPersistenceRef.current,
      };
      bumpScopeContentRevision(scopePersistenceTarget);
      if (stateRef.current.promotedSessionId) {
        // 首发接纳到路由切换之间仍是同一 pane；这一窄窗口需同步更新 owner，避免 render 读取 ref。
        const nextDraft = {
          ...stateRef.current.draft,
          editorStateJson: undefined,
          mention: undefined,
          ...content,
        };
        const nextState = { ...stateRef.current, draft: nextDraft };
        stateRef.current = nextState;
        scopePersistenceTarget.baseDraft = nextDraft;
        scopePersistenceTarget.persist = draftPersistenceRef.current;
        setStoredState(nextState);
      }
    },
    [incarnation, isCurrentScope, scopeKey, scopePersistenceTarget],
  );
  const captureComposerContentLifecycleCommit = useCallback(() => {
    const target = scopePersistenceTarget;
    let active = true;
    return (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      if (!active) return;
      active = false;
      const draft = {
        ...target.baseDraft,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      };
      target.baseDraft = draft;
      bumpScopeContentRevision(target);
      target.persist(draft);
      const pending = stagedContentRef.current;
      if (pending?.scopeKey === target.scopeKey) stagedContentRef.current = null;
    };
  }, [bumpScopeContentRevision, scopePersistenceTarget]);
  const captureComposerSubmissionDraftTransaction = useCallback(
    (content: ComposerDraftContent): ComposerSubmissionDraftTransaction => {
      const target = scopePersistenceTarget;
      const submittedContent = {
        text: content.text,
        editorStateJson: content.editorStateJson,
        mention: content.mention,
      };
      const capturedRevision = target.contentRevision.current;
      let state: "captured" | "claimed" | "restored" | "finalized" = "captured";
      let claimedRevision: number | null = null;
      let restoredRevision: number | null = null;
      const isCurrent = () =>
        mountedRef.current &&
        stateRef.current.incarnation === target.incarnation &&
        stateRef.current.draft.text === target.baseDraft.text;
      const clearPending = () => {
        const pending = stagedContentRef.current;
        if (pending?.scopeKey === target.scopeKey && pending.incarnation === target.incarnation) {
          stagedContentRef.current = null;
        }
      };
      return {
        matchesTarget: (candidateScopeToken) => candidateScopeToken === target.incarnation,
        claim: () => {
          if (
            state !== "captured" ||
            !isCurrent() ||
            target.contentRevision.current !== capturedRevision
          ) {
            return false;
          }
          const claimedDraft = {
            ...target.baseDraft,
            text: "",
            editorStateJson: undefined,
            mention: undefined,
          };
          target.baseDraft = claimedDraft;
          bumpScopeContentRevision(target);
          claimedRevision = target.contentRevision.current;
          state = "claimed";
          target.persist(claimedDraft);
          const nextState = { ...stateRef.current, draft: claimedDraft };
          stateRef.current = nextState;
          setStoredState(nextState);
          clearPending();
          return true;
        },
        restore: () => {
          if (state !== "claimed" || claimedRevision === null) {
            return { current: isCurrent(), applied: state === "restored" };
          }
          const current = isCurrent();
          const restored = target.contentRevision.current === claimedRevision;
          if (restored) {
            const restoredDraft = {
              ...target.baseDraft,
              ...submittedContent,
            };
            target.baseDraft = restoredDraft;
            bumpScopeContentRevision(target);
            restoredRevision = target.contentRevision.current;
            target.persist(restoredDraft);
            if (current) {
              const nextState = { ...stateRef.current, draft: restoredDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
            state = "restored";
          }
          clearPending();
          return { current, applied: restored };
        },
        release: () => {
          state = "finalized";
        },
        finalize: () => {
          // ACK、投影和发送 Promise 可先后到达；事务唯一持有结算状态，副作用只执行一次。
          if (state === "finalized") return null;
          const current = isCurrent();
          const pending = stagedContentRef.current;
          if (pending?.scopeKey === target.scopeKey && pending.incarnation === target.incarnation) {
            target.baseDraft = {
              ...pending.baseDraft,
              editorStateJson: undefined,
              mention: undefined,
              ...pending.content,
            };
            bumpScopeContentRevision(target);
            target.persist(target.baseDraft);
            stagedContentRef.current = null;
            if (current) {
              const nextState = { ...stateRef.current, draft: target.baseDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
          }
          const expectedRevision =
            state === "claimed" ? claimedRevision : state === "restored" ? restoredRevision : null;
          const finalized =
            expectedRevision !== null && target.contentRevision.current === expectedRevision;
          if (finalized) {
            const finalizedDraft = {
              ...target.baseDraft,
              text: "",
              editorStateJson: undefined,
              mention: undefined,
            };
            target.baseDraft = finalizedDraft;
            bumpScopeContentRevision(target);
            target.persist(finalizedDraft);
            if (current) {
              const nextState = { ...stateRef.current, draft: finalizedDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
          }
          state = "finalized";
          clearPending();
          return { current, applied: finalized };
        },
      };
    },
    [bumpScopeContentRevision, scopePersistenceTarget],
  );
  const persistComposerContent = useCallback(
    (content: ComposerDraftContent) => {
      if (!isCurrentScope()) return;
      // Bug 根因：350ms 自动保存走配置 setState，导致整页、Logo 和 Timeline 一起刷新。
      // 正文继续由编辑器及既有 staged buffer 持有；配置变更/发送事务仍会合并或结算它。
      stageComposerContent(content);
      persistDraft(mergeStagedContent(stateRef.current.draft));
    },
    [isCurrentScope, stageComposerContent, persistDraft, mergeStagedContent],
  );
  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      updateComposerDraft(() => ({ ...replacement, updatedAt: Date.now() }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (!isCurrentScope() || scopeId !== V4_DRAFT_SCOPE_ROOT) return false;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return false;
      // 首发 Snapshot 可能迟到：空正文只在内存交接配置，有新文字则先写目标再删来源。
      const draftForPromotion = mergeStagedContent(stateRef.current.draft);
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        draftForPromotion,
      );
      if (!written) return false;
      const staged = stagedContentRef.current;
      if (staged?.scopeKey === scopeKey) stagedContentRef.current = null;
      const next = {
        ...stateRef.current,
        draft: draftForPromotion,
        promotedSessionId: targetSessionId,
      };
      stateRef.current = next;
      const promotedPersistence = createDraftPersistence(targetSessionId);
      scopePersistenceTarget.baseDraft = draftForPromotion;
      scopePersistenceTarget.persist = promotedPersistence;
      draftPersistenceRef.current = promotedPersistence;
      setStoredState(next);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
      return true;
    },
    [
      scopeId,
      isCurrentScope,
      mergeStagedContent,
      scopeKey,
      scopePersistenceTarget,
      workspaceIdentity,
      workspacePath,
      rootScope,
    ],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string, reasoningLevel?: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 原因：调档后解析尚未返回时，菜单仍使用同 Host 的保留目录；只读 ready view
      // 会把随后主动选模写成无档位意图，永久显示“—”。目录仅用于选模，不放行提交。
      const catalog =
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
      const modelSelection = reasoningLevel
        ? { ...parsedSelection, options: { reasoningLevel } }
        : catalog
          ? (completeNewModelSelection(catalog, parsedSelection) ?? parsedSelection)
          : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [
      modelSelectionView,
      modelSelectionRead.state,
      updateDraftConfig,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      // 计划/评审互斥与权限单选的草稿迁移收敛在纯函数中（见 applyComposerModeSwitch）。
      updateComposerDraft((current) => applyComposerModeSwitch(current, mode) ?? current);
    },
    [updateComposerDraft],
  );

  // 会话级数据源绑定随草稿 scope 持久化；promote 整体转移时自动带到真实会话。
  // 同时写入项目级记忆（含取消）：同项目内的新对话按上一次显式操作恢复（specs/data-source.md
  // §7.1；用户决策改为按项目记忆，项目 id 即 draftProjectId，与草稿桶的项目作用域一致）。
  const handleDraftSelectDataSource = useCallback(
    (dataSourceId: string | null) => {
      // 会话级绑定写宿主侧 map（桌面/Web 共享、切换保持）；草稿对象同步携带驱动
      // 当前控件显示。项目级记忆（按项目）继续负责新对话初始勾选。
      if (sessionId !== null) {
        void writeSessionDataSourceBinding(dataSourceService, sessionId, dataSourceId);
      }
      writeDataSourceSelectionRecent(
        workspacePath,
        workspaceIdentity,
        dataSourceId,
        workspaceProjectId,
      );
      updateComposerDraft((current) => ({
        ...current,
        ...(dataSourceId ? { dataSourceId } : { dataSourceId: undefined }),
      }));
    },
    [
      dataSourceService,
      sessionId,
      updateComposerDraft,
      workspaceProjectId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    composerDraftRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    composerDraftScopeToken: incarnation,
    stageComposerContent,
    captureComposerContentLifecycleCommit,
    captureComposerSubmissionDraftTransaction,
    persistComposerContent,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    handleDraftSelectDataSource,
    observeDraftPermissionGrant,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
