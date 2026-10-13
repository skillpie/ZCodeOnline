#!/bin/bash
# ZCode 终端用户发行包发布（从 deploy_web.sh --release 拆出的独立入口，与 Web 隧道部署互不依赖）。
# 内容：server-cli 多平台 stage 归档 + catalog.json（宿主自动更新源）+ install.sh/ps1/cmd，
# 上传到服务器 $DL_DIR，供终端用户 curl 安装脚本与已装宿主自动更新使用（specs/web-tunnel.md）。
# 用法：
#   ./deploy_cli.sh                 # 发布默认平台（darwin-arm64 + linux-x64）
#   ./deploy_cli.sh win32-x64       # 发布指定平台（可传多个，位置参数优先级最高，
#                                   # 等价于 RELEASE_TARGETS 环境变量）
#
# 服务器与站点信息不写入本文件（deploy_web.sh 曾因此出库）：从
# apps/zcode-relay/deploy/deploy.env 读取（SERVER_HOST / SERVER_USER / SITE_URL，
# 该文件被 .gitignore 排除；缺失时也可用导出变量传入，同名变量以 env 文件优先）。

set -e

# 本脚本位于仓库根，部署资产（deploy.env / install.sh/ps1/cmd）在 apps/zcode-relay/deploy/
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ASSETS_DIR="$PROJECT_ROOT/apps/zcode-relay/deploy"

ENV_FILE="${DEPLOY_ENV_FILE:-$DEPLOY_ASSETS_DIR/deploy.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
: "${SERVER_HOST:?缺少 SERVER_HOST（写入 $DEPLOY_ASSETS_DIR/deploy.env 或用导出变量传入）}"
: "${SITE_URL:?缺少 SITE_URL（catalog 归档地址依赖它，写入 $DEPLOY_ASSETS_DIR/deploy.env 或用导出变量传入）}"
SERVER_USER="${SERVER_USER:-root}"
DL_DIR="${DL_DIR:-/var/www/zcode-dl}"

# 发布平台：位置参数 > RELEASE_TARGETS 环境变量 > 默认。win32-x64 不在默认内，需要时手动指定。
if [ $# -gt 0 ]; then
  RELEASE_TARGETS="$*"
fi
RELEASE_TARGETS="${RELEASE_TARGETS:-darwin-arm64 linux-x64}"

step() { printf '\n\033[0;34m========== %s ==========\033[0m\n' "$1"; }

# 多平台 stage 归档 + install.sh → 服务器 $DL_DIR，供终端用户 curl 安装脚本使用
# （域名由 SITE_URL 决定，安装脚本本身随仓库分发）。catalog.json 供已装宿主的
# 自动更新（specs/web-tunnel.md 更新器 M4）拉取；stage 每跑一个 target 就把条目
# 按 target 合并进本地 catalog，最后整体上传。
step "构建并发布终端用户发行包（targets: $RELEASE_TARGETS）"
CATALOG_FILE="$PROJECT_ROOT/packages/zcode-server-cli/dist-release/catalog.json"
ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $DL_DIR"
for target in $RELEASE_TARGETS; do
  (cd "$PROJECT_ROOT" && pnpm --filter @zcode/server-cli exec tsx src/packaging/stageCli.ts \
    --target "$target" --catalog "$CATALOG_FILE" --catalog-archive-base-url "$SITE_URL/dl")
  archive="$PROJECT_ROOT/packages/zcode-server-cli/dist-release/zcode-server-$target.tar.gz"
  [ -f "$archive" ] || { echo "archive missing: $archive" >&2; exit 1; }
  rsync -av --delete "$archive" "$SERVER_USER@$SERVER_HOST:$DL_DIR/zcode-server-$target.tar.gz"
  echo "[release] zcode-server-$target.tar.gz published"
done
[ -f "$CATALOG_FILE" ] || { echo "catalog missing: $CATALOG_FILE" >&2; exit 1; }
rsync -av "$CATALOG_FILE" "$SERVER_USER@$SERVER_HOST:$DL_DIR/catalog.json"
echo "[release] catalog.json published（宿主自动更新源：$SITE_URL/dl/catalog.json）"
rsync -av "$DEPLOY_ASSETS_DIR/install-zcode-server.sh" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.sh"
rsync -av "$DEPLOY_ASSETS_DIR/install-zcode-server.ps1" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.ps1"
rsync -av "$DEPLOY_ASSETS_DIR/install.cmd" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.cmd"
echo "[release] install.sh / install.ps1 / install.cmd published"

# 发布后验证：catalog 与安装脚本可公网拉取。失败只提示不中断——下载由 nginx 直出，
# 这里不可达也可能是本机网络问题，不应据此回滚已上传的产物。
step "验证"
curl -s -o /dev/null -w "$SITE_URL/dl/catalog.json: %{http_code}\n" "$SITE_URL/dl/catalog.json" || true
curl -s -o /dev/null -w "$SITE_URL/install.sh: %{http_code}\n" "$SITE_URL/install.sh" || true
