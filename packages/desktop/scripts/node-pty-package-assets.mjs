import { cpSync, existsSync, mkdirSync, chmodSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);

// 按 SDK 版本从新到旧列出 CommandLineTools 下可用的备选 SDK（默认 SDK 由编译器自己解析，
// 不包含在本列表里，仅在默认编译失败时作为重试候选）。
function listFallbackDarwinSdks() {
  const sdkRoots = [
    "/Library/Developer/CommandLineTools/SDKs",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs",
  ];
  const candidates = [];
  for (const sdkRoot of sdkRoots) {
    let entries = [];
    try {
      entries = readdirSync(sdkRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("MacOSX") || !entry.endsWith(".sdk") || entry === "MacOSX.sdk") {
        continue;
      }
      const version = Number.parseFloat(entry.slice("MacOSX".length)) || 0;
      candidates.push({ path: resolve(sdkRoot, entry), version });
    }
  }
  return candidates
    .sort((left, right) => right.version - left.version)
    .map((candidate) => candidate.path);
}

export function restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }) {
  if (targetPlatform.os !== "linux") {
    console.log(`[beforePack] node-pty prebuild restore skipped for ${targetPlatform.key}`);
    return;
  }

  const platformKey = targetPlatform.key;
  const sourcePackageName = `@lydell/node-pty-${platformKey}`;
  let sourceBinaryPath;

  try {
    sourceBinaryPath = resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`缺少 ${sourcePackageName}，无法为 ${platformKey} 打包 node-pty: ${message}`);
  }

  const nodePtyPackageRoot = dirname(
    require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }),
  );
  const targetPrebuildDir = resolve(nodePtyPackageRoot, "prebuilds", platformKey);
  const targetBinaryPath = resolve(targetPrebuildDir, "pty.node");

  // Linux 包中 node-pty 本体只会查自己的 prebuilds/linux-*/pty.node，
  // 但 Linux 预编译文件实际来自 @lydell/node-pty-linux-* 平台包；若排除该平台包，
  // 而 node-pty 自身目录没有 linux prebuild，最终安装包里会缺 pty.node，终端启动失败。
  // 这里在 beforePack 阶段恢复依赖资产，让后续 asarUnpack 按标准链路处理 native addon。
  mkdirSync(targetPrebuildDir, { recursive: true });
  cpSync(sourceBinaryPath, targetBinaryPath);

  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty 预编译产物恢复失败: ${targetBinaryPath}`);

  console.log(`[beforePack] node-pty prebuild restored: ${targetBinaryPath}`);
}

export function resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey }) {
  const sourcePackageEntry = require.resolve(sourcePackageName);
  let currentDir = dirname(sourcePackageEntry);

  while (currentDir !== dirname(currentDir)) {
    const candidatePath = resolve(currentDir, "prebuilds", platformKey, "pty.node");
    if (existsSync(candidatePath)) return candidatePath;

    currentDir = dirname(currentDir);
  }

  // @lydell/node-pty-linux-* 通过 package exports 只暴露 lib/index.js，
  // 不能再解析 package.json。这里从公开入口向上寻找 prebuilds，兼容 exports 限制。
  throw new Error(
    `缺少 node-pty 预编译产物: ${sourcePackageName}/prebuilds/${platformKey}/pty.node`,
  );
}

export function resolvePackagedNodePtyPrebuildPath({ resourcesDir, platformKey }) {
  return resolve(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    platformKey,
    "pty.node",
  );
}

// node-pty npm 包自带的 prebuilds/darwin-*/spawn-helper 带有 com.apple.provenance 扩展属性
// （npm 解包时被 macOS 打上，运行期无法移除）。宿主进程通过 posix_spawn 拉起它时会被
// 系统拒绝，表现为终端必然报 "posix_spawnp failed."；而同一份二进制在 shell 里直接执行正常，
// pty.node 本身无问题。用 clang++ 从 node-pty 源码现编一份 spawn-helper 替换即可：
// 新编译产物没有 provenance 属性，且 spawn-helper 是纯 C++（无 Node/Electron ABI 约束）。
export function rebuildDarwinNodePtySpawnHelper({ desktopPackageRoot, targetPlatform }) {
  if (targetPlatform.os !== "darwin") {
    console.log(`[beforePack] node-pty spawn-helper rebuild skipped for ${targetPlatform.key}`);
    return { rebuilt: false, reason: "non-darwin-platform" };
  }

  const nodePtyPackageRoot = dirname(
    require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }),
  );
  const helperSourcePath = resolve(nodePtyPackageRoot, "src", "unix", "spawn-helper.cc");
  const targetHelperPath = resolve(
    nodePtyPackageRoot,
    "prebuilds",
    targetPlatform.key,
    "spawn-helper",
  );

  if (!existsSync(helperSourcePath)) {
    throw new Error(`node-pty spawn-helper 源码缺失: ${helperSourcePath}`);
  }

// 同时编出 arm64 与 x86_64：CI 可能交叉打包另一种架构的 DMG，
// spawn-helper 必须能在目标机器上被直接 exec（Rosetta 不翻译 helper 的 exec 场景）。
// 部分机器的默认 SDK 存在 tbd 损坏（链接期 unknown architecture），这里按候选 SDK
// 依次重试：先用系统默认，失败再从 CommandLineTools 目录里从新到旧逐个尝试。
const tempDir = mkdtempSync(resolve(tmpdir(), "node-pty-spawn-helper-"));
const tempBinaryPath = resolve(tempDir, "spawn-helper");
const compilers = ["clang++", "c++"];
try {
  let lastError = null;
  let compiled = false;
  outer: for (const sdkRoot of [null, ...listFallbackDarwinSdks()]) {
    for (const compiler of compilers) {
      const result = spawnSync(compiler, [
        "-O2",
        "-arch",
        "arm64",
        "-arch",
        "x86_64",
        "-o",
        tempBinaryPath,
        helperSourcePath,
      ], {
        stdio: "pipe",
        ...(sdkRoot ? { env: { ...process.env, SDKROOT: sdkRoot } } : {}),
      });
      if (result.status === 0) {
        compiled = true;
        break outer;
      }
      lastError =
        result.error?.message ??
        `${compiler}${sdkRoot ? ` (SDK ${sdkRoot})` : ""} exited ${result.status}: ${String(result.stderr || "")}`.trim();
    }
  }

  if (!compiled) {
    throw new Error(`node-pty spawn-helper 编译失败: ${lastError ?? "无可用 C++ 编译器"}`);
  }

  copyFileSync(tempBinaryPath, targetHelperPath);
  chmodSync(targetHelperPath, 0o755);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

  if (!existsSync(targetHelperPath)) {
    throw new Error(`node-pty spawn-helper 替换失败: ${targetHelperPath}`);
  }

  console.log(`[beforePack] node-pty spawn-helper rebuilt: ${targetHelperPath}`);
  return { rebuilt: true, helperPath: targetHelperPath };
}
