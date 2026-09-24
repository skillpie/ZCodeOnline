import type {
  SkillMarketInstallResult,
  SkillMarketSearchResult,
  SkillMarketSkillDetail,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillMarketService {
  /** 搜索 SkillPie 公开技能目录；query 为空时返回空结果而非报错。 */
  searchSkills(params: { query: string; limit?: number }): Promise<SkillMarketSearchResult[]>;
  /** 拉取单个技能详情（含使用文档与版本信息）。 */
  getSkillDetail(params: { normalizedName: string }): Promise<SkillMarketSkillDetail>;
  /**
   * 安装免费技能到本机用户级技能目录（~/.zcode/skills/<normalizedName>）。
   * 同名目录已存在时返回 already-installed，不覆盖。
   */
  installSkill(params: { normalizedName: string }): Promise<SkillMarketInstallResult>;
}

export const ISkillMarketService = createServiceDescriptor<ISkillMarketService>(
  ServiceChannels.SkillMarket,
);
