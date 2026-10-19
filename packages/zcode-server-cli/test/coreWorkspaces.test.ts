import assert from "node:assert/strict";
import { test } from "vitest";
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

test("未设置且 cwd 是文件系统根时不下发 workspaces", () => {
  // launchd/systemd 未配置 WorkingDirectory 时服务进程 cwd 是根目录（服务管理器缺省值）。
  // 把 "/" 当初始工作区曾让每个网页会话被注入 "/" 项目并经共享 setting.json 污染桌面端。
  assert.deepEqual(resolveCoreServerWorkspaces({}, "/"), []);
});

test("显式配置 ZCODE_SERVER_WORKSPACE=/ 仍按用户选择下发", () => {
  const workspaces = resolveCoreServerWorkspaces({ ZCODE_SERVER_WORKSPACE: "/" }, "/home/demo");
  assert.deepEqual(workspaces, [{ path: "/", label: "/" }]);
});
