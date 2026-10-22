// 会话级数据源绑定的渲染层读写（用户决策：绑定存宿主侧——session-bindings.json，
// 桌面端与 Web 端共用同一份；不再依赖 composer 草稿对象，草稿的空白清理/scope
// 切换/promote 转移不会再冲掉绑定）。读写经 IDataSourceService（ServiceChannel），
// Web 端与桌面端同构。新对话的初始勾选仍由项目级记忆（dataSourceSelectionRecent）
// 负责；会话删除时由调用方触发 deleteSessionDataSourceBinding 清理。
import type { IDataSourceService } from "@zcode/services";

type DataSourceServiceLike = Pick<
  IDataSourceService,
  "getSessionDataSourceBinding" | "setSessionDataSourceBinding" | "deleteSessionDataSourceBinding"
>;

export interface SessionDataSourceBindingTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 读取会话已绑定的数据源 id；未绑定/服务缺失为 null（调用方回退项目级记忆）。 */
export async function readSessionDataSourceBinding(
  service: DataSourceServiceLike | null | undefined,
  target: SessionDataSourceBindingTarget,
  sessionId: string,
): Promise<string | null> {
  if (!service || !sessionId) return null;
  try {
    const result = await service.getSessionDataSourceBinding({ ...target, sessionId });
    return result.dataSourceId;
  } catch {
    return null;
  }
}

/** 写入/清除（null）会话绑定；失败静默（选择本身已在草稿与项目记忆中生效）。 */
export async function writeSessionDataSourceBinding(
  service: DataSourceServiceLike | null | undefined,
  target: SessionDataSourceBindingTarget,
  sessionId: string,
  dataSourceId: string | null,
): Promise<void> {
  if (!service || !sessionId) return;
  try {
    await service.setSessionDataSourceBinding({ ...target, sessionId, dataSourceId });
  } catch {
    // 静默：宿主暂不可达（旧 daemon 未升级）时不阻断选择交互。
  }
}

/** 会话删除时清理绑定（幂等）。 */
export async function deleteSessionDataSourceBinding(
  service: DataSourceServiceLike | null | undefined,
  target: SessionDataSourceBindingTarget,
  sessionId: string,
): Promise<void> {
  if (!service || !sessionId) return;
  try {
    await service.deleteSessionDataSourceBinding({ ...target, sessionId });
  } catch {
    // 静默：清理失败不阻断会话删除。
  }
}
