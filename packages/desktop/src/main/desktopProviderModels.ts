import type { ProviderListModelsRequest, ProviderListModelsResult } from "@zcode/shared";

/** models 请求超时；供应商网关慢时宁可失败也不要让设置页无限等待。 */
const FETCH_TIMEOUT_MS = 15000;
/** 候选条目上限：足够大以覆盖大型网关，同时避免异常响应撑爆渲染层。 */
const MAX_MODELS = 2000;

interface RawModelEntry {
  id?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_model_len?: unknown;
  max_output_tokens?: unknown;
  max_completion_tokens?: unknown;
}

/** 按 API 格式推导 models 列表地址（与连接设置的路径约定一致）。 */
function resolveModelsUrl(baseUrl: string, apiFormat: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  // Anthropic 的连接路径约定为 {base}/v1/messages，列表对应 {base}/v1/models；
  // OpenAI 兼容（chat-completions / responses）的 base 已含 /v1，列表挂在 {base}/models。
  return apiFormat === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`;
}

function authHeaders(apiFormat: string, apiKey: string): Record<string, string> {
  return apiFormat === "anthropic-messages"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
}

function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 解析 models 响应体：兼容裸数组 / {data:[]} / {models:[]}，按 id 去重并挑大小字段。 */
export function parseModelEntries(body: unknown): ProviderListModelsResult["models"] {
  const container = body as { data?: unknown; models?: unknown } | null;
  const entries: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : [];
  const models: ProviderListModelsResult["models"] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as RawModelEntry;
    if (typeof record.id !== "string" || record.id.length === 0 || seen.has(record.id)) continue;
    seen.add(record.id);
    models.push({
      id: record.id,
      contextWindow: toPositiveNumber(
        record.context_length ?? record.context_window ?? record.max_model_len,
      ),
      maxOutputTokens: toPositiveNumber(record.max_output_tokens ?? record.max_completion_tokens),
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** 从供应商接口拉取模型 ID 列表。凭据仅用于本次请求，日志不记录。 */
export async function listProviderModels(
  request: ProviderListModelsRequest,
): Promise<ProviderListModelsResult> {
  const baseUrl = request.baseUrl.trim();
  const apiKey = request.apiKey.trim();
  if (!baseUrl || !apiKey) {
    throw new Error("missing base url or api key");
  }
  const response = await fetch(resolveModelsUrl(baseUrl, request.apiFormat), {
    method: "GET",
    headers: { Accept: "application/json", ...authHeaders(request.apiFormat, apiKey) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body: unknown = await response.json().catch(() => null);
  return { models: parseModelEntries(body) };
}
