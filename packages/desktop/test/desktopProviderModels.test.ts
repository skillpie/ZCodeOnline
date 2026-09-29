import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { listProviderModels, parseModelEntries } from "../src/main/desktopProviderModels.js";

// 供应商一键获取模型列表（specs/model-fetch.md）：
// 响应解析兼容裸数组 / {data:[]} / {models:[]}，按 id 去重并识别大小字段；
// 请求按 apiFormat 推导 models 路径与鉴权头（main 直连，避开 renderer CORS）。

const originalFetch = globalThis.fetch;

beforeEach(() => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  (globalThis as { fetch: unknown }).fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  (globalThis as { __modelFetchCalls?: unknown }).__modelFetchCalls = calls;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { __modelFetchCalls?: unknown }).__modelFetchCalls;
});

function fetchCalls(): { url: string; init: RequestInit | undefined }[] {
  return (globalThis as { __modelFetchCalls?: { url: string; init: RequestInit | undefined }[] })
    .__modelFetchCalls!;
}

test("parseModelEntries 解析 OpenAI data[] 容器并识别上下文窗口字段", () => {
  const models = parseModelEntries({
    data: [
      { id: "glm-5.3", context_length: 200_000 },
      { id: "glm-5.3-air", context_window: 128_000, max_output_tokens: 98_304 },
    ],
  });
  assert.deepEqual(models, [
    { id: "glm-5.3", contextWindow: 200_000, maxOutputTokens: undefined },
    { id: "glm-5.3-air", contextWindow: 128_000, maxOutputTokens: 98_304 },
  ]);
});

test("parseModelEntries 兼容裸数组与 models 容器、vLLM 的 max_model_len", () => {
  assert.deepEqual(parseModelEntries([{ id: "a", max_model_len: 4096 }]), [
    { id: "a", contextWindow: 4096, maxOutputTokens: undefined },
  ]);
  assert.deepEqual(parseModelEntries({ models: [{ id: "b" }] }), [
    { id: "b", contextWindow: undefined, maxOutputTokens: undefined },
  ]);
});

test("parseModelEntries 按 id 去重并跳过非法条目", () => {
  const models = parseModelEntries({
    data: [
      null,
      "not-an-object",
      { id: "" },
      { id: "dup" },
      { id: "dup" },
      { id: "ok", max_completion_tokens: 8192 },
    ],
  });
  assert.deepEqual(models, [
    { id: "dup", contextWindow: undefined, maxOutputTokens: undefined },
    { id: "ok", contextWindow: undefined, maxOutputTokens: 8192 },
  ]);
});

test("parseModelEntries 拒绝非正数大小并截断到 2000 条", () => {
  assert.deepEqual(parseModelEntries({ data: [{ id: "x", context_length: -1 }] }), [
    { id: "x", contextWindow: undefined, maxOutputTokens: undefined },
  ]);
  const many = Array.from({ length: 2500 }, (_, index) => ({ id: `m-${index}` }));
  assert.equal(parseModelEntries({ data: many }).length, 2000);
});

test("listProviderModels 缺地址或 Key 直接抛错，不发请求", async () => {
  await assert.rejects(
    () => listProviderModels({ baseUrl: "  ", apiKey: "k", apiFormat: "openai" }),
    /missing base url or api key/,
  );
  await assert.rejects(
    () =>
      listProviderModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "",
        apiFormat: "openai",
      }),
    /missing base url or api key/,
  );
  assert.equal(fetchCalls().length, 0);
});

test("listProviderModels OpenAI 兼容格式请求 {base}/models 并带 Bearer 头", async () => {
  await listProviderModels({
    baseUrl: "https://api.example.com/v1/",
    apiKey: "sk-test",
    apiFormat: "openai-chat-completions",
  });
  const [call] = fetchCalls();
  assert.equal(call.url, "https://api.example.com/v1/models");
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
});

test("listProviderModels Anthropic 格式请求 {base}/v1/models 并带 x-api-key 头", async () => {
  await listProviderModels({
    baseUrl: "https://api.example.com",
    apiKey: "ak-test",
    apiFormat: "anthropic-messages",
  });
  const [call] = fetchCalls();
  assert.equal(call.url, "https://api.example.com/v1/models");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "ak-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("listProviderModels HTTP 错误抛出状态与响应摘要", async () => {
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response('{"error":"bad key"}', { status: 401 });
  await assert.rejects(
    () =>
      listProviderModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        apiFormat: "openai",
      }),
    /HTTP 401/,
  );
});
