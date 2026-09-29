import assert from "node:assert/strict";
import { test } from "node:test";
import { getCommunityUrlFromConfig } from "../src/remoteAppConfig.js";
import { resolveHelpAppConfig } from "../src/helpAppConfig.js";

// 社区入口回归验收：远端（zcode.z.ai /api/v1/client/configs）曾下发与实际社群
// 不符的 applink 链接（link_token=a38rfc19-…），按产品决定 community_urls 不再
// 使用远端下发，只以内置 config/default.json 为准；feedback_url 仍远端优先。

const localConfig = {
  community_urls: {
    "zh-CN":
      "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=8fan16c9-5687-489b-afd2-ec9a42261659",
    "en-US":
      "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=8fan16c9-5687-489b-afd2-ec9a42261659",
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
    "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=8fan16c9-5687-489b-afd2-ec9a42261659",
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
