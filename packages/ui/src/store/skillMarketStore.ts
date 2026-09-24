import { create } from "zustand";

/**
 * SkillPie 技能市场 UI 状态（specs/skill-market.md §5.2）。
 * detailSkill 是原生详情弹窗的唯一所有者：`/` 与 `$` 面板选中市场项后写入，
 * App 宿主按它挂载 SkillMarketDetailDialog；不透传 props、不持久化。
 * workspace 上下文随条目一并记录：安装必须经由该 workspace 解析到的 host 执行，
 * 远程 workspace 才能装进远端用户技能根，而不是本机。
 */
export interface SkillMarketDetailTarget {
  normalizedName: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface SkillMarketStoreState {
  detailSkill: SkillMarketDetailTarget | null;
  openDetail: (target: SkillMarketDetailTarget) => void;
  closeDetail: () => void;
}

export const useSkillMarketStore = create<SkillMarketStoreState>((set) => ({
  detailSkill: null,
  openDetail: (target) => {
    if (!target.normalizedName.trim() || !target.workspacePath.trim()) {
      return;
    }
    set({
      detailSkill: {
        normalizedName: target.normalizedName.trim(),
        workspacePath: target.workspacePath.trim(),
        workspaceIdentity: target.workspaceIdentity?.trim() || undefined,
      },
    });
  },
  closeDetail: () => set({ detailSkill: null }),
}));
