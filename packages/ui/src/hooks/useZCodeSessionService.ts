import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 关键业务逻辑：hooks 不能按条件调用。之前这里用三元在 useWorkspaceServices 与
  // useServices 之间二选一，workspacePath 在两次渲染间翻转（如 workspaceShellPath 为空时
  // Root 传 undefined）会让同一组件的 hook 数量骤变，生产包 React 在后续 useCallback 的
  // 依赖比较里读到错位槽位，抛 "Cannot read properties of undefined (reading 'length')"，
  // 且被 onboarding-dialog 的 silent 错误边界吞掉，只表现为草稿 composer 无法输入。
  // 现在两个 hook 都无条件调用，再用普通条件选择结果；useWorkspaceServices 对
  // undefined workspacePath 会回落到 context services，行为与原 useServices 分支一致。
  const resolutionServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const contextServices = useServices();
  const services = workspacePath ? resolutionServices : contextServices;
  return services.zcodeSessionService;
}
