// 未连接时的「挂起型」服务面（specs/web-tunnel.md §3.3 原始设计）：真实 Root 以未登录
// 空态常驻渲染，连接成功后整体换入真实服务重挂载，无任何占位假界面。
// 按服务名分派的策略（均对齐消费方的既有兜底路径）：
// - settingService：get 返回默认设置（见 DEFAULT_SUSPENDED_SETTINGS）——settings 为 null 时
//   OccupationOnboarding 会整树返回 null 挡住主界面，默认设置让首启引导跳过、主界面放行；
// - 快速拒绝：oauthService / providerSettingsService —— Root 启动门禁（OAuth 恢复、provider
//   域迁移）对拒绝全有 catch 兜底，拒绝等价「本地未登录、无配置」，workspace tab 得以注入；
// - 空视图：modelSelectionService.getView 返回空模型视图（与仓库
//   EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW 同形）——拒绝会常驻「模型加载失败」横幅，空视图
//   则静默落定为 hydrated；
// - 空成功：onboardingRecordService 全方法 resolve undefined —— shouldOnboard 立即落定为
//   「无需引导」（undefined 即 falsy）；若挂起，useOnboardingTrigger 的 3s 超时会用挂载时
//   的过期 settings 判定 needsOnboarding=true，弹出首启引导挡住主界面；
// - 挂起：其余服务方法返回永不 resolve（也不 reject）的 Promise，界面呈加载态而非错误态。
// 稳定性：每个服务/成员一个单例，hook 依赖数组拿到的引用跨渲染稳定；then/Symbol 成员返回
// undefined，防止 stub 被误当 Promise 展开；onXxx 成员按 rpc Event<T> 契约同步返回空 IDisposable。
import type { IServiceAccessor } from "@zcode/client";

/** 兼容两种事件形态的 stub：
 * - 单次订阅（rpc Event<T> 契约，如 broadcastService.onMessage(listener) → IDisposable）；
 * - 柯里工厂（如 zcodeAgentService.onDynamicLocalTtftFacts(params)(listener)）。
 * 返回值既是可继续调用的函数，也带 dispose，两种用法卸载时都不炸。 */
function createFlexibleEventStub(): (() => unknown) & { dispose(): void } {
  const event = ((..._args: unknown[]) => event) as (() => unknown) & { dispose(): void };
  event.dispose = () => {};
  return event;
}

/** 启动判定类服务：调用即拒绝（消费方均有 catch 兜底），等价本地未登录/无配置。 */
const REJECTING_SERVICES: ReadonlySet<string> = new Set(["oauthService"]);

const EMPTY_MODEL_SELECTION_VIEW = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});

// ProviderSettingsView 最小合法空视图：拒绝会让套餐入口门禁常驻
// 「Could not load plans. Retry」，空视图则静默落定为无任何已配置 Provider。
const EMPTY_PROVIDER_SETTINGS_VIEW = Object.freeze({
  revision: 0,
  providerTemplates: Object.freeze([]),
  providerOrder: Object.freeze([]),
  providers: Object.freeze([]),
});

// 挂起态设置默认值：OccupationOnboarding 在 settings 为 null 时会整树返回 null（挡住主
// 界面），带上 onboardingOccupation 即判定「已有职业记录」→ 跳过首启引导、放行主界面。
// 消费方对缺失字段均用 ?? 兜底（recentProjects/lastActiveTabIndex/providerFamilyDomain 等）。
const DEFAULT_SUSPENDED_SETTINGS = Object.freeze({ onboardingOccupation: "developer" });

/** 可调用、可链式取属性的挂起成员：调用得永不返回的 Promise，取属性递归得到挂起成员。 */
type SuspendedCallable = (...args: never[]) => Promise<never>;

function createSuspendedMember(memberCache: Map<string, unknown>, prop: string): SuspendedCallable {
  const cached = memberCache.get(prop);
  if (cached) {
    return cached as SuspendedCallable;
  }
  const proxied = new Proxy((..._args: never[]) => new Promise<never>(() => {}), {
    get(_target, nextProp) {
      if (typeof nextProp === "symbol" || nextProp === "then") {
        return undefined;
      }
      // onXxx 视为事件成员：返回兼容单次订阅与柯里工厂的灵活事件 stub。
      if (/^on[A-Z]/.test(nextProp)) {
        return createFlexibleEventStub();
      }
      return createSuspendedMember(memberCache, nextProp);
    },
    // 调用（无论挂起方法还是事件成员被误调用）统一返回永不 resolve 的 Promise。
    apply() {
      return new Promise<never>(() => {});
    },
  }) as unknown as SuspendedCallable;
  memberCache.set(prop, proxied);
  return proxied;
}

type SuspendedServicePolicy =
  | "suspend"
  | "reject"
  | "modelSelectionEmptyView"
  | "providerSettingsEmptyView"
  | "defaultSettings"
  | "resolveUndefined";

function createSuspendedService(policy: SuspendedServicePolicy): unknown {
  const memberCache = new Map<string, unknown>();
  const memberFor = (prop: string): unknown => {
    if (/^on[A-Z]/.test(prop)) {
      const existing = memberCache.get(prop);
      if (existing) return existing;
      const event = createFlexibleEventStub();
      memberCache.set(prop, event);
      return event;
    }
    if (policy === "reject") {
      const existing = memberCache.get(prop);
      if (existing) return existing;
      const rejecting = () => Promise.reject(new Error("tunnel-suspended: 服务在连接建立前不可用"));
      memberCache.set(prop, rejecting);
      return rejecting;
    }
    if (policy === "modelSelectionEmptyView" && prop === "getView") {
      const existing = memberCache.get(prop);
      if (existing) return existing;
      const getView = () => Promise.resolve(EMPTY_MODEL_SELECTION_VIEW);
      memberCache.set(prop, getView);
      return getView;
    }
    if (policy === "providerSettingsEmptyView" && prop === "getView") {
      const existing = memberCache.get(prop);
      if (existing) return existing;
      const getView = () => Promise.resolve(EMPTY_PROVIDER_SETTINGS_VIEW);
      memberCache.set(prop, getView);
      return getView;
    }
    if (policy === "defaultSettings" && (prop === "get" || prop === "getSnapshot")) {
      const existing = memberCache.get(prop);
      if (existing) return existing;
      const read = () => Promise.resolve(DEFAULT_SUSPENDED_SETTINGS);
      memberCache.set(prop, read);
      return read;
    }
    if (policy === "resolveUndefined") {
      const existing = memberCache.get(prop);
      if (existing) return existing;
      const resolveUndefined = () => Promise.resolve(undefined);
      memberCache.set(prop, resolveUndefined);
      return resolveUndefined;
    }
    return createSuspendedMember(memberCache, prop);
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") {
          return undefined;
        }
        return memberFor(prop);
      },
    },
  );
}

function policyForService(serviceName: string): SuspendedServicePolicy {
  if (REJECTING_SERVICES.has(serviceName)) {
    return "reject";
  }
  if (serviceName === "modelSelectionService") {
    return "modelSelectionEmptyView";
  }
  return "suspend";
}

/** 未连接时可传入 Root 的 IServiceAccessor：按上述策略挂起。 */
export function createSuspendedServiceAccessor(): IServiceAccessor {
  const serviceCache = new Map<string, unknown>();
  return new Proxy({} as IServiceAccessor, {
    get(_target, prop) {
      if (typeof prop === "symbol") {
        return undefined;
      }
      let service = serviceCache.get(prop);
      if (!service) {
        // settingService 返回默认设置而非拒绝：settings 为 null 时 OccupationOnboarding
        // 会整树返回 null 挡住主界面（见 DEFAULT_SUSPENDED_SETTINGS）；
        // onboardingRecordService 空成功而非挂起：见「空成功」策略说明（避免首启引导弹出）；
        // codingPlanSubscriptionService 空成功而非挂起：挂起会在订阅态查询超时后
        // 常驻「Could not load plans」黑色 toast；
        // providerSettingsService 空视图而非拒绝：拒绝让套餐入口门禁进入 error 态（同上 toast）；
        // credentialService 空成功而非挂起：套餐查询 Promise.all 等它落定后才能到达 ready。
        const policy: SuspendedServicePolicy =
          prop === "settingService"
            ? "defaultSettings"
            : prop === "onboardingRecordService" ||
                prop === "codingPlanSubscriptionService" ||
                prop === "credentialService"
              ? "resolveUndefined"
              : prop === "providerSettingsService"
                ? "providerSettingsEmptyView"
                : policyForService(prop);
        service = createSuspendedService(policy);
        serviceCache.set(prop, service);
      }
      return service;
    },
  });
}
