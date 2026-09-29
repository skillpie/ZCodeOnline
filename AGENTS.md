## 核心原则

- 本文件只记录 Agent 容易出错的场景与工程定制规则，通用编程知识不沉淀；新增条目一行一条祈使句，具体到命令、类名与文件路径。
- 新增或修改行为前，不要求先写 spec，改为使用 `.agents/skills/grill` 技能对方案进行拷问式评审：遍历设计分支、每次一个问题并附推荐答案，能从代码库得到答案的先查代码库；明确产品规则、状态所有者、接口和验收场景并达成共识后，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 技术栈

**运行时**: Node 24.14.0（`mise.toml` 锁定）| pnpm 10.33.2 | TypeScript ^6.0.2
**桌面**: Electron 41.0.3 | electron-builder ^26.8.1
**前端**: React 19.2.7（根 `pnpm.overrides` 锁定）| Zustand ^5.0.12 | Tailwind CSS ^4.2.2 | Vite | SWR | Radix UI / shadcn
**服务端**: Hono | ws | node-pty
**测试**: Node 内置 `node:test` + `tsx --test`（入口见各包 `package.json` 的 `test` 脚本）
**质量工具**: oxlint | oxfmt | knip | architecture-check

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准；首次初始化执行 `pnpm bootstrap`（需要远程 workspace 功能时用 `pnpm bootstrap:with-remote`）。

以下命令从仓库根目录执行：

| 用途                            | 命令                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| 初始化                          | `pnpm bootstrap`                                                                         |
| 类型检查                        | `pnpm typecheck`                                                                         |
| Lint                            | `pnpm lint` / `pnpm lint:fix`                                                            |
| 格式化                          | `pnpm fmt` / `pnpm fmt:check`                                                            |
| 桌面开发                        | `pnpm dev:desktop`（`ZCODE_ENV=production`）                                             |
| 桌面测试环境                    | `pnpm dev:desktop:test`（`ZCODE_ENV=test`）；隔离数据目录用 `mise run dev`               |
| Web 开发                        | `pnpm dev:web`                                                                           |
| 提交前检查                      | `pnpm verify:pre-push`（Lint 与架构检查）                                                |
| 架构检查                        | `pnpm architecture:check --changed`                                                      |
| 模块阅读包                      | `pnpm architecture:context <module-id>`                                                  |
| 未使用依赖与导出                | `pnpm knip`                                                                              |
| 导出引用查询                    | `pnpm dep:refs --list-exports <file>`                                                    |
| 桌面端打包并重装本机（macOS）   | `./install_destop.sh`（`--skip-build` 只重装）                                           |
| 桌面端打包并安装本机（Windows） | `.\install_destop.ps1`（`-SkipBuild` 只安装）                                            |
| Web 隧道部署                    | `./deploy_web.sh`（读取 `apps/zcode-relay/deploy/deploy.env`，该文件含服务器信息不入库） |

- 每次成功 `git commit` 后，husky `post-commit` 钩子后台自动执行 `./deploy_web.sh` 部署 Web 隧道，日志在 `~/.zcode/logs/web-tunnel-deploy.log`；rebase/merge/cherry-pick 的自动提交不触发，锁目录防并发。
- 测试使用 Node 内置 `node:test`（如 `pnpm --filter @zcode/relay test` 即 `tsx --test test/*.test.ts`），入口以目标包当前 `package.json` 和实际测试文件为准，不假定统一的单测或 E2E 命令。
- `pnpm architecture:context` 的 `<module-id>` 取自 `architecture-policy.yaml`（rpc、shared、provider、provider-node、services、session、storage、client、server、zcode-server-cli、ui、web、desktop、formal-proof、zcode-cli、zcode-relay）。

仓库结构：

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端（Hono + ws）。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `packages/provider`、`packages/provider-node`：模型 Provider 注册、账号与模型选择解析（Node 侧配置持久化与文件编解码）。
- `packages/zcode-server-cli`：服务端 CLI；`packages/formal-proof`：基于 d3 的 trace 可视化调试页（Vite 独立应用）；`packages/model-option-map`：模型选项映射的编译与求值库。
- `packages/zcode-cua`：Computer Use 占位包，此构建下运行面全部不可用（fail closed）。
- `apps/zcode-cli`：Agent CLI 与运行时；`apps/zcode-relay`：外部中继服务端（Web 隧道部署对象）。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 可执行架构策略在 `architecture-policy.yaml`，不在本文件重复其规则；`pnpm architecture:baseline:update` 仅在评审通过、有意接受基线变化时使用，CI 不会自动刷新基线。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
