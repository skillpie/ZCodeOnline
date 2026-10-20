interface RootStartupGateState {
  isResolvingStartupAuthState: boolean;
  isResolvingProviderStartupState: boolean;
  isRestoring: boolean;
  isBootstrappingInitialWorkspace: boolean;
}

interface RootStartupLoadingVisibilityState extends RootStartupGateState {
  isDesktop: boolean | undefined;
  welcomeScreenOpen: boolean;
}

interface FallbackWorkspaceCreateState {
  isMounted: boolean;
  activeWorkspacePath: string | null;
}

interface ProviderStartupSyncState {
  providerFamilyDomainMigrationComplete: boolean;
  modelSelectionViewHydrated: boolean;
}

interface ProviderAvailabilityLoginEntryGuardState {
  isWebRemoteControlRoot: boolean;
  /** 服务面未就绪（如 Web 隧道挂起态）时登录服务不可用，守卫必须整体禁用。 */
  suppressLoginEntry?: boolean;
}

interface ProviderStartupResolutionState {
  isWebRemoteControlRoot: boolean;
  providerStartupSyncPending: boolean;
  providerAvailabilityStartupCheckCompleted: boolean;
}

interface ProviderAvailabilityStartupCheckDeferralState {
  isResolvingStartupAuthState: boolean;
  providerStartupSyncPending: boolean;
  /** settings 快照未落定时 providerFamilyDomain 不可信，不能作为判定输入。 */
  appSettingsLoading: boolean;
}

export function shouldBlockRootRender(state: RootStartupGateState): boolean {
  return (
    state.isResolvingStartupAuthState ||
    state.isResolvingProviderStartupState ||
    state.isRestoring ||
    state.isBootstrappingInitialWorkspace
  );
}

export function shouldShowRootStartupLoading(state: RootStartupLoadingVisibilityState): boolean {
  // 修复原因：登录入口是启动门禁的结果，不是可继续被门禁遮挡的后台状态。
  // 如果 WelcomeScreen 已经打开，继续返回启动 loading 会把未登录用户卡在黑屏 logo。
  return Boolean(state.isDesktop) && !state.welcomeScreenOpen && shouldBlockRootRender(state);
}

export function shouldEnableProviderAvailabilityLoginEntryGuard(
  state: ProviderAvailabilityLoginEntryGuardState,
): boolean {
  // 修复原因：手机 Web 远控只 attachment 到桌面已有 host，不能用本地空 provider
  // 快照触发登录页，否则断连/home-only 首页会被 WelcomeScreen 覆盖。
  // Web 隧道挂起态同理：OAuth 服务是快速拒绝的 stub、settings 是桩默认值，
  // 守卫若照常运行会把"未连接"误判成"未配置账号"，把整页替换成
  // 带「没有可用的登录提供方」警告的欢迎页；登录入口必须等服务面就绪。
  return !state.isWebRemoteControlRoot && !state.suppressLoginEntry;
}

export function shouldResolveProviderStartupState(state: ProviderStartupResolutionState): boolean {
  if (state.isWebRemoteControlRoot) {
    // 修复原因：Web 远控的 workspace tab 由 shared-host bridge 注入；
    // provider 可用性属于桌面 host 侧状态，不应阻断手机端 paired loading / workspace 注入。
    return false;
  }

  return state.providerStartupSyncPending || !state.providerAvailabilityStartupCheckCompleted;
}

export function shouldOpenFallbackWorkspaceAfterCreate(
  state: FallbackWorkspaceCreateState,
): boolean {
  return state.isMounted && !state.activeWorkspacePath;
}

export function isProviderStartupSyncPending(state: ProviderStartupSyncState): boolean {
  return !state.providerFamilyDomainMigrationComplete || !state.modelSelectionViewHydrated;
}

export function shouldDeferProviderAvailabilityStartupCheck(
  state: ProviderAvailabilityStartupCheckDeferralState,
): boolean {
  // 启动登录入口检查是一次性判定：任何输入（登录态恢复、provider 启动同步、settings 快照）
  // 未落定都必须延后，否则会用中间态数据误开/误关登录入口。
  // 尤其是 settings：迁移完成位先于 refreshAppSettings() 置位，settings 未加载时
  // providerFamilyDomain 恒为 undefined，会被误判成「未配置账号」而打开登录页。
  return (
    state.isResolvingStartupAuthState ||
    state.providerStartupSyncPending ||
    state.appSettingsLoading
  );
}
