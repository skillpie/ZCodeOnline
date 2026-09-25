import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INSTALL_URL,
  detectTunnelInstallPlatform,
  tunnelInstallCommands,
} from "../src/tunnel/tunnelInstall.js";

// 门禁安装引导的平台分流（specs/web-tunnel.md §5.7）：
// Windows UA → PowerShell/CMD 一键脚本；其余 UA（macOS/Linux/手机/未知）→ POSIX curl。
// 公开 Agent 代装入口固定为 /agent/install（nginx 别名），不得泄露内部 /api/* 路由。

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("Windows UA 判定为 windows 平台，展示 PowerShell 与 CMD 两条命令", () => {
  assert.equal(detectTunnelInstallPlatform(CHROME_WINDOWS), "windows");
  const commands = tunnelInstallCommands("windows");
  assert.deepEqual(
    commands.map((item) => item.shell),
    ["PowerShell", "CMD"],
  );
  assert.match(commands[0]!.command, /^irm https:\/\/zcode\.skillpie\.cn\/install\.ps1 \| iex$/);
  assert.match(commands[1]!.command, /install\.cmd -o install\.cmd && install\.cmd$/);
});

test("macOS / Linux / 手机 / 空 UA 一律按 POSIX 展示 curl install.sh", () => {
  for (const userAgent of [CHROME_MAC, FIREFOX_LINUX, SAFARI_IPHONE, ""]) {
    assert.equal(detectTunnelInstallPlatform(userAgent), "posix", userAgent);
    const [only] = tunnelInstallCommands(detectTunnelInstallPlatform(userAgent));
    assert.equal(only!.shell, null);
    assert.equal(only!.command, "curl -fsSL https://zcode.skillpie.cn/install.sh | sh");
  }
});

test("Agent 代装入口是公开别名 /agent/install，不暴露内部 /api/* 路由", () => {
  assert.equal(AGENT_INSTALL_URL, "https://zcode.skillpie.cn/agent/install");
  assert.ok(!AGENT_INSTALL_URL.includes("/api/"));
});
