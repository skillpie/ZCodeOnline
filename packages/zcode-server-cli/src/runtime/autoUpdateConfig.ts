/**
 * 自动更新（specs/web-tunnel.md §更新器 M4）的配置解析与默认值。
 *
 * 与手动 `zcode update` 的语义差异：
 * - 手动命令未设置 ZCODE_SERVER_RELEASE_MANIFEST_URL 时不联网（保持离线 pending 语义）；
 * - 自动调度器在未设置时走 DEFAULT_RELEASE_CATALOG_URL（官方站点随 --release 发布），
 *   显式设置环境变量仍然生效，供自托管指向自己的镜像。
 */

export const DEFAULT_RELEASE_CATALOG_URL = "https://zcode.skillpie.cn/dl/catalog.json";

export interface AutoUpdateSettings {
  enabled: boolean;
  catalogUrl: string;
  /** Supervisor 启动到首次检查的延迟；避开开机高峰也让首次检查不至于挤占启动。 */
  initialDelayMs: number;
  /** 两次检查的基准间隔。 */
  intervalMs: number;
  /** 每次定时的随机抖动上限，避免大量宿主在发布后同一时刻并发拉取。 */
  maxJitterMs: number;
}

export const AUTO_UPDATE_DEFAULTS: Omit<AutoUpdateSettings, "enabled" | "catalogUrl"> = {
  initialDelayMs: 5 * 60_000,
  intervalMs: 24 * 60 * 60_000,
  maxJitterMs: 30 * 60_000,
};

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60_000;

function parseIntervalMs(raw: string | undefined): number {
  if (!raw?.trim()) return AUTO_UPDATE_DEFAULTS.intervalMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return AUTO_UPDATE_DEFAULTS.intervalMs;
  return Math.min(Math.max(value, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

export function resolveAutoUpdateSettings(
  env: NodeJS.ProcessEnv = process.env,
): AutoUpdateSettings {
  const flag = env.ZCODE_SERVER_AUTO_UPDATE?.trim().toLowerCase();
  return {
    enabled: !(flag !== undefined && DISABLE_VALUES.has(flag)),
    catalogUrl: env.ZCODE_SERVER_RELEASE_MANIFEST_URL?.trim() || DEFAULT_RELEASE_CATALOG_URL,
    initialDelayMs: AUTO_UPDATE_DEFAULTS.initialDelayMs,
    intervalMs: parseIntervalMs(env.ZCODE_SERVER_AUTO_UPDATE_INTERVAL_MS),
    maxJitterMs: AUTO_UPDATE_DEFAULTS.maxJitterMs,
  };
}
