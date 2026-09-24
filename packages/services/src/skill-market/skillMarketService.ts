/**
 * SkillPie 技能市场服务：搜索 / 详情 / 安装。
 * 走 skillpie 公开 HTTP 接口（免鉴权，见 specs/skill-market.md §5），
 * 运行在 host 进程（services/node.ts 注册），Web 模式经 RPC 代理到 server 执行，规避浏览器 CORS。
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SKILL_MARKET_URL,
  type SkillMarketSearchResult,
  type SkillMarketSkillDetail,
} from "@zcode/shared";
import type { ISkillMarketService } from "./skillMarket.js";
import { installSkillPackage } from "./skillMarketInstall.js";
import { normalizeSkillSyncRelativePath } from "../skill-sync/skillSyncPath.js";

const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 20;
const API_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface SkillMarketServiceOptions {
  /** 用户级技能根目录；默认 ~/.zcode/skills，测试时注入临时目录。 */
  userSkillRoot?: string;
  /** 市场站点地址；默认 ZCODE_SKILL_MARKET_URL env → 线上 DEFAULT_SKILL_MARKET_URL。 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** baseUrl：默认线上 skillpie，可用 ZCODE_SKILL_MARKET_URL 覆盖用于自部署联调。 */
export function resolveSkillMarketBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZCODE_SKILL_MARKET_URL?.trim();
  if (override) {
    try {
      return new URL(override).toString();
    } catch {
      // 非法 override 忽略，回落线上地址。
    }
  }
  return DEFAULT_SKILL_MARKET_URL;
}

function joinMarketUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

function resolveAbsoluteMarketUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//iu.test(url)) {
    return url;
  }
  return joinMarketUrl(baseUrl, url);
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `skill market request failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toScreenshotUrls(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw.map((item) => item.trim()).filter(Boolean);
}

export function createSkillMarketService(
  options: SkillMarketServiceOptions = {},
): ISkillMarketService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const userSkillRoot = options.userSkillRoot ?? join(resolveUserHomeDir(), ".zcode", "skills");
  const baseUrl = options.baseUrl ?? resolveSkillMarketBaseUrl();

  const assertSafeNormalizedName = (normalizedName: string): string => {
    return normalizeSkillSyncRelativePath(normalizedName, {
      unsafePathLabel: "unsafe skill market name",
    });
  };

  const service: ISkillMarketService = {
    async searchSkills(params): Promise<SkillMarketSearchResult[]> {
      const query = params.query.trim();
      if (!query) {
        return [];
      }
      const limit = Math.min(Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
      const searchParams = new URLSearchParams({ query, limit: String(limit) });
      const data = await fetchJson<{ skills?: Array<Record<string, unknown>> }>(
        fetchImpl,
        joinMarketUrl(baseUrl, `/api/skills?${searchParams.toString()}`),
      );
      return (data.skills ?? []).map((skill) => ({
        id: typeof skill.id === "string" ? skill.id : "",
        name: typeof skill.name === "string" ? skill.name : "",
        normalizedName: typeof skill.normalizedName === "string" ? skill.normalizedName : "",
        category: typeof skill.category === "string" ? skill.category : null,
        description: typeof skill.description === "string" ? skill.description : "",
        ownerDisplayName: typeof skill.ownerDisplayName === "string" ? skill.ownerDisplayName : "",
        downloadCount: toFiniteNumber(skill.downloadCount),
        likeCount: toFiniteNumber(skill.likeCount),
        versionNo: toFiniteNumber(
          (skill.version as Record<string, unknown> | undefined)?.versionNo,
        ),
        isFree: skill.isFree !== false,
      }));
    },

    async getSkillDetail(params): Promise<SkillMarketSkillDetail> {
      const normalizedName = assertSafeNormalizedName(params.normalizedName);
      const data = await fetchJson<{ skill?: Record<string, unknown> }>(
        fetchImpl,
        joinMarketUrl(
          baseUrl,
          `/api/skills/by-normalized-name/${encodeURIComponent(normalizedName)}`,
        ),
      );
      const skill = data.skill;
      if (!skill) {
        throw new Error(`skill not found in market: ${normalizedName}`);
      }
      const version = skill.version as Record<string, unknown> | undefined;
      const packageDownloadUrl =
        typeof version?.packageDownloadUrl === "string" && version.packageDownloadUrl.length > 0
          ? resolveAbsoluteMarketUrl(baseUrl, version.packageDownloadUrl)
          : null;
      return {
        id: typeof skill.id === "string" ? skill.id : "",
        name: typeof skill.name === "string" ? skill.name : normalizedName,
        normalizedName,
        category: typeof skill.category === "string" ? skill.category : null,
        description: typeof skill.description === "string" ? skill.description : "",
        ownerDisplayName: typeof skill.ownerDisplayName === "string" ? skill.ownerDisplayName : "",
        downloadCount: toFiniteNumber(skill.downloadCount),
        likeCount: toFiniteNumber(skill.likeCount),
        isFree: skill.isFree !== false,
        usageInstructions:
          typeof skill.usageInstructions === "string" ? skill.usageInstructions : null,
        screenshots: toScreenshotUrls(skill.screenshots).map((url) =>
          resolveAbsoluteMarketUrl(baseUrl, url),
        ),
        version: version
          ? {
              versionNo: toFiniteNumber(version.versionNo),
              packageDownloadUrl,
              packageSize: toFiniteNumber(version.packageSize, 0) || null,
            }
          : null,
      };
    },

    async installSkill(params) {
      const normalizedName = assertSafeNormalizedName(params.normalizedName);
      // 先查目标目录，已安装时不再发起详情/下载请求。
      const existingTarget = join(userSkillRoot, normalizedName);
      if (existsSync(existingTarget)) {
        return {
          status: "already-installed",
          name: normalizedName,
          normalizedName,
          versionNo: null,
          path: existingTarget,
        };
      }
      const detail = await service.getSkillDetail({ normalizedName });
      if (!detail.isFree) {
        throw new Error("paid skills must be installed from the skill marketplace");
      }
      const version = detail.version;
      let downloadUrl = version?.packageDownloadUrl ?? null;
      if (!downloadUrl) {
        // 详情未带包地址时回退 download-url 接口（免费技能免鉴权）。
        const data = await fetchJson<{ downloadUrl?: string }>(
          fetchImpl,
          joinMarketUrl(
            baseUrl,
            `/api/skills/by-normalized-name/${encodeURIComponent(normalizedName)}/download-url`,
          ),
        );
        downloadUrl = data.downloadUrl ? resolveAbsoluteMarketUrl(baseUrl, data.downloadUrl) : null;
      }
      if (!downloadUrl) {
        throw new Error("skill package download url is unavailable");
      }
      const response = await fetchImpl(downloadUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`skill package download failed (${response.status})`);
      }
      const archive = new Uint8Array(await response.arrayBuffer());
      return installSkillPackage({
        archive,
        normalizedName,
        name: detail.name,
        versionNo: version?.versionNo ?? null,
        userSkillRoot,
      });
    },
  };
  return service;
}
