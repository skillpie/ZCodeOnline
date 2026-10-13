import { describe, expect, it } from "vitest";
import {
  getCommunityUrlFromConfig,
  getFeedbackUrlFromConfig,
  getForceUpdateMinimalVersionFromConfig,
} from "../src/remoteAppConfig.js";

describe("remoteAppConfig", () => {
  it("读取 feedback_url", () => {
    expect(
      getFeedbackUrlFromConfig({
        feedback_url: "https://example.com/feedback",
      }),
    ).toBe("https://example.com/feedback");
  });

  it("中文界面只读取中文社群地址", () => {
    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "zh-CN": "https://example.com/zh-community",
            "en-US": "https://example.com/en-community",
          },
        },
        "zh-CN",
      ),
    ).toBe("https://example.com/zh-community");

    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "en-US": "https://example.com/en-community",
          },
        },
        "zh-CN",
      ),
    ).toBeUndefined();
  });

  it("英文界面只读取英文社群地址", () => {
    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "zh-CN": "https://example.com/zh-community",
            "en-US": "https://example.com/en-community",
          },
        },
        "en-US",
      ),
    ).toBe("https://example.com/en-community");

    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "zh-CN": "https://example.com/zh-community",
          },
        },
        "en-US",
      ),
    ).toBeUndefined();
  });

  it("两个语言渠道都缺失时返回 undefined", () => {
    expect(getCommunityUrlFromConfig({}, "zh-CN")).toBeUndefined();
  });

  it("社群地址只读单一内置配置源（本地策略，远端合流函数已随策略下线）", () => {
    // 社区入口不再做远端×本地合流（远端曾下发与实际社群不符的 applink 链接），
    // resolveHelpAppConfig 只用 getCommunityUrlFromConfig 读本地配置。
    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "en-US": "https://local.example.com/discord",
          },
        },
        "en-US",
      ),
    ).toBe("https://local.example.com/discord");
    expect(getCommunityUrlFromConfig({ community_urls: {} }, "en-US")).toBeUndefined();
  });

  it("读取 forceUpdate minimalVersion", () => {
    expect(
      getForceUpdateMinimalVersionFromConfig({
        forceUpdate: {
          minimalVersion: " 4.0.0 ",
        },
      }),
    ).toBe("4.0.0");

    expect(getForceUpdateMinimalVersionFromConfig({})).toBeUndefined();
    expect(
      getForceUpdateMinimalVersionFromConfig({
        forceUpdate: {
          minimalVersion: "",
        },
      }),
    ).toBeUndefined();
  });
});
