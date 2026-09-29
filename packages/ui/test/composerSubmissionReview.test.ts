// 评审开关随提交冻结的单元覆盖。
// 核心不变量：reviewEnabled 只在开启时冻结进 Submission（「携带即开启」）；关闭是
// 缺省态不占用协议字段；冻结结果不可变，await 后切换开关不影响本次请求。
import test from "node:test";
import assert from "node:assert/strict";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";
import type { ModelSelectionView } from "@zcode/services";

const view = {
  revision: 1,
  providers: [
    {
      providerId: "p",
      models: [
        {
          modelId: "m",
          config: { optionSpecs: { reasoningLevel: { values: ["high"] } } },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;

const base = {
  mode: "build",
  modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
};

test("review switch on is frozen into submission", () => {
  const submission = createComposerSubmissionConfig({ ...base, reviewEnabled: true }, view);
  assert.equal(submission?.reviewEnabled, true);
});

test("review switch off stays absent from submission payload", () => {
  const submission = createComposerSubmissionConfig({ ...base, reviewEnabled: false }, view);
  assert.equal(submission?.reviewEnabled, undefined);
  assert.ok(!("reviewEnabled" in (submission ?? {})));
});

test("frozen submission keeps reviewEnabled after composer intent changes", () => {
  const composer = { ...base, reviewEnabled: true };
  const submission = createComposerSubmissionConfig(composer, view);
  composer.reviewEnabled = false;
  assert.equal(submission?.reviewEnabled, true);
  assert.equal(Object.isFrozen(submission), true);
});
