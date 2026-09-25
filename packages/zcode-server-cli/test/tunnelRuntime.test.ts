import assert from "node:assert/strict";

// 测试封闭性：默认开启会连 relay，统一覆盖为死地址，禁止测试触达生产。
process.env.ZCODE_RELAY_URL = "ws://127.0.0.1:9";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createTunnelRuntime,
  resolveTunnelConfigFile,
  type TunnelRuntime,
} from "../src/tunnel/tunnelRuntime.js";
import { resolveTunnelStateFile } from "../src/tunnel/tunnelState.js";

// 隧道运行时验收（specs/web-tunnel.md §3.2 daemon 集成）：
// 配置文件所有权在 Core 运行时；enable/pair 前置校验；重启后按配置恢复意图；
// disable 只删配置保留宿主身份。

let serverRoot: string;

before(async () => {
  serverRoot = await mkdtemp(join(tmpdir(), "zcode-tunnel-runtime-"));
});

after(async () => {
  await rm(serverRoot, { recursive: true, force: true });
});

async function readConfig(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolveTunnelConfigFile(serverRoot), "utf8"));
  } catch {
    return null;
  }
}

test("出厂默认开启：无需 enable 即自动拉起连接器，pair 直接可用", async () => {
  const runtime = createTunnelRuntime({ serverRoot, loopbackPort: 3030 });
  try {
    const status = await runtime.handle("status");
    assert.equal(status.status.enabled, true, "未配置过的机器默认开启");
    assert.equal(status.status.relayUrl, "ws://127.0.0.1:9", "env 覆盖优先于出厂默认");
    assert.equal(status.status.connected, true, "serve 启动即自动拉起连接器");
    const pair = await runtime.handle("pair");
    assert.ok(pair.pairingUrl?.startsWith("zcode-tunnel://pair?"));
  } finally {
    runtime.dispose();
  }
});

test("enable 持久化配置；跨运行时恢复意图且宿主身份稳定", async () => {
  const first = createTunnelRuntime({ serverRoot, loopbackPort: 3030 });
  const enabled = await first.handle("enable", "ws://127.0.0.1:1");
  assert.equal(enabled.status.enabled, true);
  assert.equal(enabled.status.relayUrl, "ws://127.0.0.1:1");
  const configOnDisk = await readConfig();
  assert.deepEqual(configOnDisk, { enabled: true, relayUrl: "ws://127.0.0.1:1" });
  first.dispose();

  // 模拟 daemon 重启：新运行时按配置自动拉起连接器，宿主身份沿用同一文件。
  const second = createTunnelRuntime({ serverRoot, loopbackPort: 3030 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = await second.handle("status");
  assert.equal(status.status.enabled, true, "重启后必须按配置恢复隧道意图");
  assert.equal(status.status.relayUrl, "ws://127.0.0.1:1");
  assert.ok(status.status.hostId.length > 0, "宿主身份应已生成");
  second.dispose();

  const identityAfterRestart = await readFile(resolveTunnelStateFile(serverRoot), "utf8");
  assert.ok(JSON.parse(identityAfterRestart).hostId === status.status.hostId);
});

test("disable 持久化关闭：跨运行时不复活，宿主身份保留", async () => {
  const first = createTunnelRuntime({ serverRoot, loopbackPort: 3030 });
  const disabled = await first.handle("disable");
  assert.equal(disabled.status.enabled, false);
  assert.equal(disabled.status.connected, false);
  first.dispose();

  // 跨运行时：disable 必须持久化（出厂默认开启，删除配置会让 disable 复活）。
  const second = createTunnelRuntime({ serverRoot, loopbackPort: 3030 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = await second.handle("status");
  assert.equal(status.status.enabled, false, "重启后必须保持关闭");
  assert.equal(status.status.connected, false);
  second.dispose();

  const configOnDisk = (await readConfig()) as { enabled: boolean };
  assert.equal(configOnDisk.enabled, false, "config.json 必须记录 enabled=false");
  const identity = JSON.parse(await readFile(resolveTunnelStateFile(serverRoot), "utf8"));
  assert.ok(identity.hostId.length > 0, "身份文件必须保留");
});

test("pair 在连接器存在时返回配对 URL（连接器对死 relay 仅退避重试）", async () => {
  const runtime: TunnelRuntime = createTunnelRuntime({ serverRoot, loopbackPort: 3030 });
  try {
    await runtime.handle("enable", "ws://127.0.0.1:1");
    const pair = await runtime.handle("pair");
    assert.ok(pair.pairingUrl?.startsWith("zcode-tunnel://pair?"));
    assert.ok((pair.expiresAt ?? 0) > Date.now());
  } finally {
    runtime.dispose();
  }
});
