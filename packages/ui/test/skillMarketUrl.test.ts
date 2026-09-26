import assert from "node:assert/strict";
import test from "node:test";
import { SKILL_MARKET_SKILLS_URL, SKILL_MARKET_URL } from "../src/lib/skillMarketUrl.js";

test("skill market urls default to skillpie production", () => {
  assert.equal(SKILL_MARKET_URL, "https://skillpie.cn/");
  assert.equal(SKILL_MARKET_SKILLS_URL, "https://skillpie.cn/skills");
});
