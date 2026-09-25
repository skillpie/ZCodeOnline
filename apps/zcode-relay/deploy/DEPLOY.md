# 部署：zcode.skillpie.cn（Web 隧道形态）

目标：浏览器打开 `https://zcode.skillpie.cn` 即进入隧道门禁屏，配对后经加密隧道操作各自电脑上的 ZCode。架构与安全模型见 `specs/web-tunnel.md`。

```
浏览器 https://zcode.skillpie.cn
   │  nginx（skillpie 服务器 106.53.164.221）：/ 静态 Web；/relay/ 剥前缀反代 127.0.0.1:8787
   ▼
relay（systemd zcode-relay，单文件 entry.js，只绑回环，node=/usr/local/bin/node）
   ▲  宿主出站 WSS（用户电脑上的 server-cli daemon）
```

## 前提（一次性）

- [ ] **DNS**：`zcode.skillpie.cn` A 记录 → 106.53.164.221（skillpie.cn 的 DNS 控制台加一条子域名解析）。
- [x] 证书：服务器已有 `*.skillpie.cn` 通配符证书（`/etc/nginx/ssl/skillpie.cn.pem`），子域名直接可用。
- [x] node：`/usr/local/bin/node` 已存在（skillpie 主服务同款）。

## 一键部署

```bash
cd apps/zcode-relay/deploy
./deploy-zcode.sh            # 构建（本机）→ rsync → systemd → nginx → 验证
# 细粒度：--web（仅静态资源）/ --relay（仅 relay）/ --ng（仅 nginx conf）/ --check（仅验证）
```

脚本做的事：本机 `VITE_TUNNEL_ENTRY=1` 构建 web + esbuild 打包 relay 单文件 → rsync 到 `/var/www/zcode` 与 `/opt/zcode-relay` → 安装/重启 `zcode-relay.service` → MD5 比对上传 `zcode.skillpie.cn.conf` 到 `/etc/nginx/conf.d/` 并 reload → 本机+公网验证。

> 与 skillpie 工程的 deploy.sh 模型差异：skillpie 是服务器 git pull + 构建；ZCode monorepo 太重，改为**本机构建 + rsync 产物**。nginx conf 走同一个 conf.d 目录，`nginx -t && reload` 的更新方式与 skillpie 一致。
>
> 注意：本仓库的 conf 不能 include `skillpie_common.conf`（其内部 `location /` 代理到 Next.js，与静态站点冲突），SSL 参数已按等值复制，注释见 conf 文件头。

## 部署后验证

1. `./deploy-zcode.sh --check` —— relay systemd 状态 + 控制面 401 语义 + 公网首页/relay 路由。
2. 浏览器打开 `https://zcode.skillpie.cn/` → 直接看到「连接到你的电脑」门禁屏（无需 `?tunnel=1`）。
3. 端到端：本机 `zcode tunnel-enable --relay-url wss://zcode.skillpie.cn/relay && zcode tunnel-pair` → 浏览器粘贴链接 → 进入完整应用。

## 升级

```bash
./deploy-zcode.sh              # 全量（web + relay）
./deploy-zcode.sh --web        # 纯前端迭代：rsync 覆盖即生效，无需重启
./deploy-zcode.sh --relay      # relay 升级：重启服务，宿主 daemon 指数退避自动重连
```

## 终端用户安装（"浏览器写代码"最小集，三平台）

本机构建发行包：`pnpm --filter @zcode/server-cli stage --target <target>` → `dist-release/zcode-server-<target>.tar.gz`（自包含：node 22 + server-cli + zcode.cjs + 依赖闭包，免预装 Node）。发布：`deploy-zcode.sh --release`（构建 darwin-arm64/linux-x64/win32-x64 并上传 `/var/www/zcode-dl/` + 三个安装脚本）。

用户侧：

```bash
# macOS / Linux
curl -fsSL https://zcode.skillpie.cn/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://zcode.skillpie.cn/install.ps1 | iex
# Windows CMD
curl -fsSL https://zcode.skillpie.cn/install.cmd -o install.cmd && install.cmd
```

安装后统一收尾：`zcode serve`（启动即打印远程链接）→ 浏览器打开打印的链接。模型登录为**可选**步骤——界面左下角登录入口随时可用；命令行方式（`zcode login`，OAuth 授权-轮询，凭据落 `~/.zcode/v2/credentials.json` 供宿主 agent 使用）适合 headless 预配置场景。

- 工作区：`--workspace`（POSIX）/ `-Workspace`（PowerShell）写入安装目录 `env` 文件（`ZCODE_SERVER_WORKSPACE`），core 的 server-info/bootstrap 帧据此注入浏览器。
- win32 归档需在 Windows 或交叉环境构建验证（stage 支持 `--target win32-x64`）；当前已发布构建为 darwin-arm64 / linux-x64。

## 安全清单

- relay 只绑 127.0.0.1，公网入口一律走 nginx TLS；隧道业务帧由两端 PSK 派生密钥端到端加密——服务器被攻破只见密文与路由元数据。
- **配对鉴权已设为 `ZCODE_RELAY_PAIRING_AUTH=none`**（本部署特有取舍）：自有域名无 OAuth 回调，登录链路不可用，故配对码即唯一能力凭证（32 字节随机 + 2 分钟 TTL + 一次性，防枚举）。风险面 = 配对链接在 2 分钟窗口内泄露；缓解 = 不外传链接、宿主侧配对确认（M2）。默认模式（jwt）要求 ZAI 账号，供官方部署使用。
- relay 无业务状态；设备-账号绑定表驻内存，relay 重启后需重新配对（生产化可换 SQLite 持久化，接口已预留）。
- 登录（OAuth）在自有域名暂不可用：回调固定指向官方线上页，`app_return_to` 白名单不含本域——隧道配对不依赖登录（安全基于 32 字节随机配对码 + 2 分钟 TTL + 一次性）。多设备账号管理是二期（需注册回调 URI + token 交换后端 + 放宽 shared 白名单）。
