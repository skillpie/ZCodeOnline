import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSafeAppReturnTo } from "../src/auth/oauthStateCodec.js";

// 登录回跳校验（specs/web-tunnel.md §5.7）：同源维持分享流语义（仅 share 路径、
// 返回站内路径）；跨域仅放行构建期/注入的受信 origin（返回完整 URL）；其余拒绝。
// node 环境下 import.meta.env 不存在，模块默认白名单为空——用 options 显式注入。

const OFFICIAL = "https://zcode.z.ai";
const SELF_HOST = "https://zcode.skillpie.cn";

test("同源分享路径维持既有语义：返回站内路径", () => {
  assert.equal(
    resolveSafeAppReturnTo(`${OFFICIAL}/cn/share/abc123`, { currentOrigin: OFFICIAL }),
    "/cn/share/abc123",
  );
  assert.equal(
    resolveSafeAppReturnTo(`${OFFICIAL}/share/x`, { currentOrigin: OFFICIAL }),
    "/share/x",
  );
});

test("同源非 share 路径拒绝（沿用旧白名单）", () => {
  assert.equal(resolveSafeAppReturnTo(`${OFFICIAL}/?tunnel=1`, { currentOrigin: OFFICIAL }), null);
  assert.equal(
    resolveSafeAppReturnTo(`${OFFICIAL}/1234567890123456`, { currentOrigin: OFFICIAL }),
    null,
  );
});

test("跨域非受信 origin 一律拒绝（默认白名单为空）", () => {
  assert.equal(resolveSafeAppReturnTo(`${SELF_HOST}/1234567890123456`), null);
  assert.equal(
    resolveSafeAppReturnTo(`${SELF_HOST}/1234567890123456`, { currentOrigin: OFFICIAL }),
    null,
  );
  assert.equal(resolveSafeAppReturnTo("https://evil.example/redirect"), null);
});

test("跨域受信 origin 放行：返回完整 URL（含路径与查询串）", () => {
  const trustedOrigins = [SELF_HOST];
  assert.equal(
    resolveSafeAppReturnTo(`${SELF_HOST}/1234567890123456`, {
      currentOrigin: OFFICIAL,
      trustedOrigins,
    }),
    `${SELF_HOST}/1234567890123456`,
  );
  assert.equal(
    resolveSafeAppReturnTo(`${SELF_HOST}/?tunnel=1`, { currentOrigin: OFFICIAL, trustedOrigins }),
    `${SELF_HOST}/?tunnel=1`,
  );
});

test("受信 origin 条目做归一化：容忍尾斜缀", () => {
  assert.equal(
    resolveSafeAppReturnTo(`${SELF_HOST}/x`, {
      currentOrigin: OFFICIAL,
      trustedOrigins: [`${SELF_HOST}/`],
    }),
    `${SELF_HOST}/x`,
  );
});

test("URL 内嵌凭据或非 http(s) 协议一律拒绝", () => {
  assert.equal(
    resolveSafeAppReturnTo(`https://user:pass@${SELF_HOST.replace("https://", "")}/x`, {
      currentOrigin: OFFICIAL,
      trustedOrigins: [SELF_HOST],
    }),
    null,
  );
  assert.equal(
    resolveSafeAppReturnTo("javascript:alert(1)", {
      currentOrigin: OFFICIAL,
      trustedOrigins: [SELF_HOST],
    }),
    null,
  );
});

test("受信 origin 上 http 明文不匹配 https 归一化结果", () => {
  assert.equal(
    resolveSafeAppReturnTo("http://zcode.skillpie.cn/x", {
      currentOrigin: OFFICIAL,
      trustedOrigins: [SELF_HOST],
    }),
    null,
  );
});
