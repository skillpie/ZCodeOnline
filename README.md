# ZCodeOnline

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCodeOnline" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZCodeOnline 是基于 ZCode 的 AI 编程工作台升级版：一套源码，覆盖桌面应用、浏览器界面和终端 Agent。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源并完成引导构建。需要远程工作区功能时改用 `pnpm bootstrap:with-remote`（额外准备远程资源）；全量构建执行 `pnpm build`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，随仓库一起克隆，无需单独初始化 submodule。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop        # 生产服务配置（默认）
pnpm dev:desktop:test   # 测试环境
```

需要独立数据目录时设置 `ZCODE_DATA_BASE_DIR`，例如 `ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test`。

远程（SSH/WSL）开发：先执行 `pnpm bootstrap:with-remote` 准备远程资源，连接远程项目时资源选择「本地下载后上传」；开发态资源经 SFTP 上传到远程，不访问 CDN。

### Web 版

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`），浏览器访问前者。Agent 源码修改后执行 `pnpm --filter @zcode/cli... build` 并重启服务。

### 命令行版

命令行发行包含 TUI、Web 和 Agent，统一由 `zcode` 启动：

```bash
zcode                    # 默认进入终端交互界面
zcode --web              # 启动 Web 界面
zcode --web --workspace /path/to/project --port 3030 --no-open
zcode --help             # 查看 CLI 或 Web 参数
```

Web 模式默认监听 `127.0.0.1` 并自动打开浏览器；局域网访问用 `--host 0.0.0.0`，监听非本机地址时默认启用令牌认证，可用 `--token` / `--no-token` 覆盖。

直接开发 TUI 或 Agent 源码时使用 `pnpm --filter @zcode/cli dev`；验证统一的 `zcode` 命令需先按下方打包章节构建并解压发行包。

## 配置

根目录 [.env.example](.env.example) 提供配置示例，可复制为 `.env`，本地覆盖放入 `.env.local`。随客户端发布的默认配置见 [config/README.md](config/README.md)。

| 配置                                 | 用途                                     |
| ------------------------------------ | ---------------------------------------- |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/` |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                     |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径               |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址           |

## 打包

第三方声明生成与发行校验流程见 [third-party/README.md](third-party/README.md)。

### 桌面版

```bash
pnpm bundle:desktop                      # 默认 macOS arm64，输出到 packages/desktop/dist/
pnpm bundle:desktop -- --os win --arch x64
```

`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。产物为 `ZCodeOnline-*.dmg` 等发行包，双击将 ZCodeOnline 拖入「应用程序」。本地构建未签名，macOS 首次打开被拦截时执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCodeOnline.app
```

也可用根目录一键脚本完成「打包 + 替换本机安装」（可与正式版并排；`--skip-build` / `-SkipBuild` 只重装不构建）：

```bash
./install_destop.sh                # macOS
```

```powershell
.\install_destop.ps1               # Windows（NSIS 静默安装）
```

### Web 隧道部署

```bash
./deploy_web.sh    # 构建 Web 与 relay，rsync 上传并重启服务；--web / --relay / --ng / --check / --release 为细粒度入口
```

服务器与站点信息从 `apps/zcode-relay/deploy/deploy.env` 读取，该文件与 nginx conf、systemd unit 均含部署侧信息，**不入库**，需在部署机自行准备；缺失时脚本报错退出。

### 命令行版

构建入口为 `pnpm build:zcode`，打包前必须提供下载根地址（`ZCODE_DIST_BASE_URL` 或 `--base-url`）：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 复用已有构建产物，仅重新组包
pnpm build:zcode --skip-build
```

输出位于 `dist/zcode/`：`releases/<version>/` 下的运行包与 sha256 摘要，以及 `latest.json`、`install.sh`。安装脚本默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令，目录可通过 `ZCODE_DIST_HOME`、`ZCODE_DIST_BIN_DIR` 调整。本地调试可直接解压运行包，执行其中的 `bin/zcode.mjs`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
