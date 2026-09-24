import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BindingStore,
  ConnectTokenStore,
  PairingTokenStore,
  RouteTable,
  SessionStore,
} from "../src/tunnelStore.js";

// relay 状态语义验收（specs/web-tunnel.md §3.5）：一次性消费、TTL 过期、吊销联动、路由顶替。

test("pairing token：一次性消费，过期与重放一律 miss", () => {
  const store = new PairingTokenStore();
  let now = 1_000;
  store.register("hash-1", "h1", 2_000, now);
  assert.equal(store.consume("hash-1", now + 1), "h1");
  assert.equal(store.consume("hash-1", now + 2), null, "重放必须失败");
  store.register("hash-2", "h1", 2_000, now);
  assert.equal(store.consume("hash-2", 2_001), null, "过期必须失败");
  assert.equal(store.consume(undefined, now), null);
});

test("session：TTL 内可重复校验，按宿主整组吊销", () => {
  const store = new SessionStore();
  const now = 1_000;
  store.issue("cred-a", { user: "u1", hostId: "h1", expiresAt: 5_000 }, now);
  store.issue("cred-b", { user: "u2", hostId: "h1", expiresAt: 5_000 }, now);
  store.issue("cred-c", { user: "u1", hostId: "h2", expiresAt: 5_000 }, now);
  assert.equal(store.verify("cred-a", now + 1)?.user, "u1");
  assert.equal(store.verify("cred-a", 5_001), null, "过期拒绝");
  store.revokeByHost("h1");
  assert.equal(store.verify("cred-a", now + 2), null);
  assert.equal(store.verify("cred-b", now + 2), null);
  assert.equal(store.verify("cred-c", now + 2)?.hostId, "h2", "其他宿主不受影响");
});

test("binding：按用户列举与解绑", () => {
  const bindings = new BindingStore();
  bindings.bind({ user: "u1", hostId: "h1", displayName: "dev" });
  bindings.bind({ user: "u1", hostId: "h2", displayName: "lab" });
  bindings.bind({ user: "u2", hostId: "h3", displayName: "mac" });
  assert.equal(bindings.listForUser("u1").length, 2);
  assert.equal(bindings.isBound("u1", "h1"), true);
  assert.equal(bindings.unbind("u1", "h1"), true);
  assert.equal(bindings.isBound("u1", "h1"), false);
  assert.equal(bindings.isBound("u2", "h3"), true);
});

test("connect token：一次性消费且过期 miss", () => {
  const store = new ConnectTokenStore();
  store.register("tok-hash", { user: "u1", hostId: "h1" }, 2_000, 1_000);
  assert.deepEqual(store.consume("tok-hash", 1_500), { user: "u1", hostId: "h1" });
  assert.equal(store.consume("tok-hash", 1_600), null, "票据只能用一次");
  store.register("tok-2", { user: "u1", hostId: "h1" }, 2_000, 1_000);
  assert.equal(store.consume("tok-2", 2_001), null);
});

test("route：顶替旧连接，摘除时校验归属", () => {
  const routes = new RouteTable<string>();
  routes.setRoute("h1", "conn-1");
  const superseded = routes.setRoute("h1", "conn-2");
  assert.equal(superseded, "conn-1");
  assert.equal(routes.getRoute("h1"), "conn-2");
  assert.equal(routes.removeRoute("h1", "conn-1"), false, "旧连接不能摘除新连接的路由");
  assert.equal(routes.getRoute("h1"), "conn-2");
  assert.equal(routes.removeRoute("h1", "conn-2"), true);
  assert.equal(routes.getRoute("h1"), null);
});
