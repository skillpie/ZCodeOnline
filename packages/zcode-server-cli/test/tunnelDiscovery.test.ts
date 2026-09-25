import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  startTunnelDiscoveryServer,
  type TunnelDiscoveryServer,
} from "../src/tunnel/tunnelDiscovery.js";

// 本地配对发现端点验收（specs/web-tunnel.md §5.8）：
// 白名单 origin 的 CORS/PNA 头、非白名单 403、每次 GET 生成新鲜会话、隧道未就绪 503。

const ALLOWED = ["https://zcode.skillpie.cn"];
let server: TunnelDiscoveryServer;
let pairCalls = 0;

before(async () => {
  server = await startTunnelDiscoveryServer({
    port: 0,
    allowedOrigins: ALLOWED,
    pair: async () => {
      pairCalls += 1;
      return {
        pairingUrl: `zcode-tunnel://pair?v=1&token=${pairCalls}-${Date.now()}`,
        expiresAt: Date.now() + 120_000,
        status: { hostId: "h-disc", displayName: "disc-box" },
      };
    },
  });
});

after(async () => {
  await server.close();
});

const get = async (origin?: string, path = "/tunnel/pairing") =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: origin ? { origin } : {},
  });

test("白名单 origin：CORS + PNA 头齐全，返回新鲜配对会话", async () => {
  const first = await get(ALLOWED[0]);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("access-control-allow-origin"), ALLOWED[0]);
  assert.equal(first.headers.get("access-control-allow-private-network"), "true");
  const body = (await first.json()) as { pairingUrl: string; displayName: string };
  assert.match(body.pairingUrl, /^zcode-tunnel:\/\/pair\?/);
  assert.equal(body.displayName, "disc-box");

  // 每次 GET 生成新会话（浏览器打开页面总能拿到可用配对码，无 TTL 焦虑）
  const second = await get(ALLOWED[0]);
  const secondBody = (await second.json()) as { pairingUrl: string };
  assert.notEqual(secondBody.pairingUrl, body.pairingUrl);
  assert.equal(pairCalls, 2);
});

test("OPTIONS preflight：PNA 放行（公网 HTTPS → 本地端点）", async () => {
  const preflight = await fetch(`http://127.0.0.1:${server.port}/tunnel/pairing`, {
    method: "OPTIONS",
    headers: { origin: ALLOWED[0] },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
});

test("非白名单 origin：403 且不带 CORS 头（恶意站点读不到配对码）", async () => {
  const evil = await get("https://evil.example.com");
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const noOrigin = await get();
  assert.equal(noOrigin.status, 403);
});

test("非端点路径：白名单 origin 得 404", async () => {
  const other = await get(ALLOWED[0], "/tunnel/other");
  assert.equal(other.status, 404);
});
