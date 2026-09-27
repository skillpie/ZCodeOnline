import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 关键业务逻辑：hooks 不能按条件调用（与 useZCodeSessionService 同一处历史缺陷）。
  // workspacePath 在两次渲染间翻转会让 hook 数量骤变，生产包 React 在后续 useCallback
  // 依赖比较里读到错位槽位直接崩溃。两个 hook 都无条件调用，再按参数选择结果；
  // useWorkspaceServices 对 undefined workspacePath 会回落到 context services，行为不变。
  const resolutionServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  const services = workspacePath ? resolutionServices : contextServices;
  return services.zcodeAgentService;
}
