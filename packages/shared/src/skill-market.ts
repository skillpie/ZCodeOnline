/**
 * SkillPie 技能市场（https://skillpie.cn）公开接口的类型契约。
 * 字段以 skillpie CLI 源码与线上实测为准（specs/skill-market.md §5）；
 * 远端字段为宽松映射，缺失时由服务层兜底，不在协议层做严格校验。
 */

/** 搜索接口（GET /api/skills?query=&limit=）返回的单条技能摘要。 */
export interface SkillMarketSearchResult {
  id: string;
  name: string;
  normalizedName: string;
  category: string | null;
  description: string;
  ownerDisplayName: string;
  downloadCount: number;
  likeCount: number;
  versionNo: number;
  isFree: boolean;
}

export interface SkillMarketSkillVersion {
  versionNo: number;
  /** 技能包 zip 的下载地址，可能是相对路径（需拼 baseUrl）。 */
  packageDownloadUrl: string | null;
  packageSize: number | null;
}

/** 详情接口（GET /api/skills/by-normalized-name/<normalizedName>）返回的技能详情。 */
export interface SkillMarketSkillDetail {
  id: string;
  name: string;
  normalizedName: string;
  category: string | null;
  description: string;
  ownerDisplayName: string;
  downloadCount: number;
  likeCount: number;
  isFree: boolean;
  /** 使用说明 markdown（服务端 usageInstructions 字段）。 */
  usageInstructions: string | null;
  /** 预览图 URL 列表；接口为 null/缺失时为空数组。 */
  screenshots: string[];
  version: SkillMarketSkillVersion | null;
}

export type SkillMarketInstallStatus = "installed" | "already-installed";

export interface SkillMarketInstallResult {
  status: SkillMarketInstallStatus;
  name: string;
  normalizedName: string;
  versionNo: number | null;
  /** 安装目标目录（用户级技能根下的技能目录）。 */
  path: string;
}
