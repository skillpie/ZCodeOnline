# Spec: 桌面产品身份与打包边界（Desktop Product Identity）

> 实现入口：`packages/desktop/scripts/desktop-product-identity.mjs`（打包期身份）、
> `packages/desktop/src/main/desktopRuntimeEnv.ts`（运行时应用名/数据目录）、
> `packages/desktop/tsup.config.ts`（workspace 包内联白名单）。
> 本 spec 记录 2026-09 起本仓库（fork）的身份决策与打包边界规则。

## 1. 产品规则

- 产品身份（flavor）与后端环境（`ZCODE_ENV`）是两个独立的轴：
  - `ZCODE_ENV=test` 一律 Preview 身份，产物带 `_TEST` 后缀；
  - `ZCODE_ENV=production` 默认正式身份，`ZCODE_PREVIEW_IDENTITY=1` 时改用 Preview 身份（可与正式版并排安装）。
- **本 fork 的 Preview 身份命名为 `ZCodePlus`**（原 `ZCode Preview`）：appId `dev.zcode.app.plus`，
  Linux 可执行名/包名 `zcode-plus`。运行时应用名与 Electron userData 目录同为 `ZCodePlus`
  （`~/Library/Application Support/ZCodePlus`），与官方 `ZCode` 完全隔离，不存在包名/数据目录冲突。
- 内部 flavor 键仍为 `preview`（`ZCODE_PRODUCT_FLAVOR` 编译期常量），仅对外展示名变更；
  Helper 安装变体子目录沿用 `preview` 值，不迁移。

## 2. 打包边界规则

- workspace 包（`@zcode/*`）的 `package.json` `exports` 指向 `src/*.ts` 源码；Electron 生产运行时
  没有 TS loader，**所有被 main/host/scheduler 引用的 `@zcode/*` 包必须加入 tsup `noExternal`
  内联白名单**，不能留下指向 `src/*.ts` 的裸包引用。
- 违反后果：electron-builder 排除 `node_modules/@zcode`，安装包启动即
  `ERR_MODULE_NOT_FOUND`（仓库外安装时）；仓库内 dist 启动则经目录上溯解析回工作区源码，
  在 `.js` 后缀 specifier 处崩溃。
- 已知例外：`mysql2`/`pg`/`undici`/`yauzl`/`node-forge` 等 CJS 包因动态 require 必须保持
  `external`（见 tsup.config 注释），但它们不属于 `@zcode/*` workspace 源码包。
- **外置 CJS 包双清单规则**：凡加入 tsup `desktopNodeRuntimeExternals` 的第三方包，必须同时登记
  `electron-builder.config.js` 的 `REQUIRED_ASAR_RUNTIME_MODULES`（afterPack 注入）与
  `bundle.mjs` 的 `requiredRuntimeModules`（产物机械校验）；只外置不登记会导致安装包启动即
  `ERR_MODULE_NOT_FOUND`（mysql2/pg 漏登记已实际触发，2026-09-26 修复）。

## 3. 验收场景

1. `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop` 产物安装名/运行名均为
   `ZCodePlus`，启动后数据目录落在 `Application Support/ZCodePlus`，与 `/Applications/ZCode.app`
   互不读写。
2. 打包产物内 `out/main/index.js` 不含指向 `@zcode/*` 的裸 import specifier。
3. 应用主进程启动不出现 `ERR_MODULE_NOT_FOUND`（隧道管理面 `@zcode/server-cli/control`
   随主进程 bundle 内联）。
