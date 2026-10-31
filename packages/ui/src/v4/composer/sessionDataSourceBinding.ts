// 会话级数据源绑定的渲染层读写（用户决策：绑定存宿主侧——session-bindings.json，
// 桌面端与 Web 端共用同一份；不再依赖 composer 草稿对象，草稿的空白清理/scope
// 切换/promote 转移不会再冲掉绑定）。sessionId 全局唯一、不按 workspace 分桶，
// Web 端（remote identity）与桌面端（本地路径）对同一会话天然读到同一条绑定。
// 新对话的初始勾选仍由项目级记忆（dataSourceSelectionRecent）负责；会话删除与
// 首发落盘由宿主命令漏斗收口（settleSessionDataSourceBindingOnAck），渲染层不记账。
import type { IDataSourceService } from "@zcode/services";

type DataSourceServiceLike = Pick<
  IDataSourceService,
  "getSessionDataSourceBinding" | "setSessionDataSourceBinding"
>;

/** 读取会话已绑定的数据源 id；未绑定/服务缺失为 null（调用方回退项目级记忆）。 */
export async function readSessionDataSourceBinding(
  service: DataSourceServiceLike | null | undefined,
  sessionId: string,
): Promise<string | null> {
  if (!service || !sessionId) return null;
  try {
    const result = await service.getSessionDataSourceBinding({ sessionId });
    return result.dataSourceId;
  } catch {
    return null;
  }
}

/** 写入/清除（null）会话绑定；失败静默（选择本身已在草稿与项目记忆中生效）。 */
export async function writeSessionDataSourceBinding(
  service: DataSourceServiceLike | null | undefined,
  sessionId: string,
  dataSourceId: string | null,
): Promise<void> {
  if (!service || !sessionId) return;
  try {
    await service.setSessionDataSourceBinding({ sessionId, dataSourceId });
  } catch {
    // 静默：宿主暂不可达（旧 daemon 未升级）时不阻断选择交互。
  }
}
