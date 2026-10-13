import assert from "node:assert/strict";
import { describe, expect, it, test, vi } from "vitest";
import { getCommunityUrlFromConfig } from "../src/remoteAppConfig.js";
import { createHelpAppConfigReader, resolveHelpAppConfig } from "../src/helpAppConfig.js";

// 社区入口回归验收：远端（zcode.z.ai /api/v1/client/configs）曾下发与实际社群
// 不符的 applink 链接（link_token=a38rfc19-…），按产品决定 community_urls 不再
// 使用远端下发，只以内置 config/default.json 为准；feedback_url 仍远端优先。

const localConfig = {
  community_urls: {
    "zh-CN":
      "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=e9ch50de-7cb0-4cb2-9adf-2ba13d632868",
    "en-US":
      "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=e9ch50de-7cb0-4cb2-9adf-2ba13d632868",
  },
  feedback_url: "https://local.example.com/feedback",
};

const remoteConfig = {
  community_urls: {
    "zh-CN":
      "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=a38rfc19-39af-4404-b28b-6f91327084eb",
    "en-US": "https://discord.gg/z9aBcQXZQ3",
  },
  feedback_url: "https://remote.example.com/feedback",
};

test("getCommunityUrlFromConfig 按语言取值并对缺失语言保持隐藏", () => {
  assert.equal(
    getCommunityUrlFromConfig(localConfig, "zh-CN"),
    "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=e9ch50de-7cb0-4cb2-9adf-2ba13d632868",
  );
  assert.equal(getCommunityUrlFromConfig(localConfig, "ja-JP"), undefined);
  assert.equal(getCommunityUrlFromConfig(undefined, "zh-CN"), undefined);
  assert.equal(
    getCommunityUrlFromConfig({ community_urls: { "zh-CN": "  " } }, "zh-CN"),
    undefined,
  );
});

test("resolveHelpAppConfig 社区地址只取本地，远端下发的 community_urls 不生效", () => {
  const resolved = resolveHelpAppConfig(remoteConfig, localConfig);
  assert.equal(resolved.community_urls?.["zh-CN"], localConfig.community_urls["zh-CN"]);
  assert.equal(resolved.community_urls?.["en-US"], localConfig.community_urls["en-US"]);
});

test("resolveHelpAppConfig feedback_url 仍远端优先，本地兜底", () => {
  assert.equal(
    resolveHelpAppConfig(remoteConfig, localConfig).feedback_url,
    "https://remote.example.com/feedback",
  );
  const remoteBroken = { ...remoteConfig, feedback_url: "" };
  assert.equal(
    resolveHelpAppConfig(remoteBroken, localConfig).feedback_url,
    "https://local.example.com/feedback",
  );
});

const envelope = (feedbackUrl: unknown) => ({ code: 0, data: { configs: { feedbackUrl } } });
const local = {
  community_urls: { "zh-CN": "https://local.cn", "en-US": "https://local.en" },
  feedback_url: "https://local.feedback",
  feedback_use_external_form: true,
};

describe("help app config", () => {
  it("远端 false 覆盖本地 true；社区地址在合流策略下仍取本地", () => {
    expect(
      resolveHelpAppConfig(
        { community_urls: { "zh-CN": "https://remote.cn" }, feedback_use_external_form: false },
        local,
      ),
    ).toEqual({
      community_urls: { "zh-CN": "https://local.cn", "en-US": "https://local.en" },
      feedback_url: "https://local.feedback",
      feedback_use_external_form: false,
    });
  });
  it("有效 envelope、no-store、并发合并、TTL 和 endpoint 隔离", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(envelope({ feedback_url: "https://remote.feedback" })),
      );
    const read = createHelpAppConfigReader({ fetchImpl, now: () => now });
    const [a, b] = await Promise.all([read("https://a/configs"), read("https://a/configs")]);
    expect(a).toEqual(b);
    expect(a.feedback_url).toBe("https://remote.feedback");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "omit" });
    await read("https://a/configs");
    await read("https://b/configs");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 3_600_001;
    await read("https://a/configs");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([{}, { code: 1, data: { configs: { feedbackUrl: {} } } }, envelope(null)])(
    "无效响应不进入缓存 %j",
    async (body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      const read = createHelpAppConfigReader({ fetchImpl });
      await expect(read("https://a/configs")).rejects.toThrow();
      await expect(read("https://a/configs")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
  it.each([new Response("bad", { status: 503 }), new Response("not json")])(
    "HTTP 和 JSON 错误不缓存",
    async (response) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response.clone());
      const read = createHelpAppConfigReader({ fetchImpl });
      await expect(read("https://a/configs")).rejects.toThrow();
      await expect(read("https://a/configs")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});

it("超时信号传递到网络层，失败后可重试", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  const read = createHelpAppConfigReader({ fetchImpl });
  await expect(read("https://a/configs")).rejects.toThrow("timeout");
  expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  fetchImpl.mockImplementation(async () =>
    Response.json(envelope({ feedback_url: "https://recovered" })),
  );
  expect((await read("https://a/configs")).feedback_url).toBe("https://recovered");
});

it("旧 endpoint 的迟到响应不覆盖新 endpoint", async () => {
  let finishOld!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).includes("old"))
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    return Response.json(envelope({ feedback_url: "https://new" }));
  });
  const read = createHelpAppConfigReader({ fetchImpl });
  const old = read("https://old/configs");
  expect((await read("https://new/configs")).feedback_url).toBe("https://new");
  finishOld(Response.json(envelope({ feedback_url: "https://old" })));
  await old;
  expect((await read("https://new/configs")).feedback_url).toBe("https://new");
});
