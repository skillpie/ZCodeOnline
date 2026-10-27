// Jiti runtime staging for the bundled main agent bundle.
//
// extension-host 在运行时用 jiti 动态加载用户 TS 扩展，esbuild 无法内联这种
// 对 bundle 外文件的动态 require（会被 __require 垫片拦下），所以 zcode.cjs
// 把 jiti 外部化（cli/scripts/build.mjs resolveBuildExternal）。桌面主 bundle
// 只 stage zcode.cjs 本身、没有主 node_modules 树；且 electron-builder 会对
// extraResources 拷贝树里的 node_modules 按 desktop 生产依赖做裁剪——
// 2026-10-27 事故：jiti stage 到 glm/node_modules 后整目录被剪掉，模块顶层
// 静态 import 在启动时 MODULE_NOT_FOUND，直接拖死启动准备进程。所以这里
// stage 到 glm/runtime-deps/jiti：整条祖先链没有任何 node_modules 命名，
// 任何裁剪都碰不到；extension-host 的 loadJitiFactory 按同名候选路径显式解析。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function isJitiPackage(candidate) {
  try {
    return JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8")).name === "jiti";
  } catch {
    return false;
  }
}

function resolveJitiRoot(repoRoot) {
  const candidates = [
    resolve(repoRoot, "node_modules", "jiti"),
    resolve(repoRoot, "apps", "zcode-cli", "node_modules", "jiti"),
  ];
  for (const candidate of candidates) {
    if (isJitiPackage(candidate)) return candidate;
  }
  throw new Error(`[jiti-package-assets] cannot resolve installed jiti package from ${repoRoot}`);
}

export function stageJitiIntoBundledAgents({ repoRoot, glmDir }) {
  if (!repoRoot || !glmDir) {
    throw new Error("[jiti-package-assets] repoRoot and glmDir are required");
  }
  const sourceRoot = resolveJitiRoot(repoRoot);
  const targetRoot = resolve(glmDir, "runtime-deps", "jiti");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  // jiti 零依赖、纯 JS，整包 dereference 拷贝（pnpm 下源路径是 store 符号链接）。
  cpSync(sourceRoot, targetRoot, { recursive: true, dereference: true });
  return targetRoot;
}

export function verifyStagedJiti({ resourcesDir }) {
  const jitiRoot = resolve(resourcesDir, "glm", "runtime-deps", "jiti");
  return existsSync(resolve(jitiRoot, "package.json")) &&
    existsSync(resolve(jitiRoot, "lib", "jiti.cjs"))
    ? []
    : [`missing staged jiti runtime: ${jitiRoot}`];
}
