import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// tsup 配置自身会被打包，构建工具需保留原始文件位置，不能被内联后重定位。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

// 版本号必须与 server/desktop/web 构建同源注入：漏掉 __ZCODE_VERSION__ 会让
// 发行版 daemon 的 zcode status 永远回落显示 "0.0.0-dev"，无法排障与核对更新。
const rootPackageJsonPath = resolve(import.meta.dirname, "../../package.json");
const { version } = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8")) as { version: string };

export const SERVER_CLI_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(version),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

export default defineConfig({
  entry: {
    "server-cli": "src/main.ts",
    "server-core": "src/server-core/entry.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  splitting: false,
  banner: {
    // __filename/__dirname 供打包后代码定位资源；createRequire 兜住 ws 等 CJS 依赖在
    // ESM 产物里的动态 require（否则 dist/server-cli.js 直接运行即抛错）。
    js: 'import { fileURLToPath as __zcodeFileURLToPath } from "node:url"; import { dirname as __zcodeDirname } from "node:path"; import { createRequire as __zcodeCreateRequire } from "node:module"; const __filename = __zcodeFileURLToPath(import.meta.url); const __dirname = __zcodeDirname(__filename); const require = __zcodeCreateRequire(import.meta.url);',
  },
  noExternal: ["@zcode/shared", "@zcode/rpc", "@zcode/services"],
  define: SERVER_CLI_DEFINES,
  external: [
    "node-pty",
    "ssh2",
    "yaml",
    "node-forge",
    "undici",
    "axios",
    "form-data",
    "combined-stream",
    "proxy-from-env",
    "follow-redirects",
    "@lydell/node-pty-darwin-arm64",
    "@lydell/node-pty-darwin-x64",
    "@lydell/node-pty-linux-arm64",
    "@lydell/node-pty-linux-x64",
  ],
});
