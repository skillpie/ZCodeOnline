import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCoreServerWorkspaces } from "../src/server-core/http.js";

// Core 初始工作区解析验收（specs/web-tunnel.md §5.7）：
// ZCODE_SERVER_WORKSPACE 优先，未设置回退 cwd；label 取目录名。

test("ZCODE_SERVER_WORKSPACE 指向项目目录", () => {
  const workspaces = resolveCoreServerWorkspaces(
    { ZCODE_SERVER_WORKSPACE: "/Users/demo/my-project" },
    "/elsewhere",
  );
  assert.deepEqual(workspaces, [{ path: "/Users/demo/my-project", label: "my-project" }]);
});

test("未设置时回退 cwd", () => {
  const workspaces = resolveCoreServerWorkspaces({}, "/home/demo/repo");
  assert.deepEqual(workspaces, [{ path: "/home/demo/repo", label: "repo" }]);
});

test("空白值视为未设置；相对路径按 cwd 之外解析为绝对路径", () => {
  const blank = resolveCoreServerWorkspaces({ ZCODE_SERVER_WORKSPACE: "   " }, "/home/demo/repo");
  assert.equal(blank[0]?.path, "/home/demo/repo");
  const relative = resolveCoreServerWorkspaces(
    { ZCODE_SERVER_WORKSPACE: "projects/demo" },
    "/base",
  );
  assert.ok(relative[0]?.path.startsWith("/"), "相对路径必须解析为绝对路径");
  assert.equal(relative[0]?.label, "demo");
});
