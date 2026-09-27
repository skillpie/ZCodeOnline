#!/bin/bash
# ZCode Web 隧道一键部署。
# 模型：本机构建 + rsync 产物（ZCode monorepo 不适合在服务器上构建）。
# 产物：静态 Web（/var/www/zcode）+ relay 单文件（/opt/zcode-relay）+ nginx conf + systemd unit。
# 用法：
#   ./deploy_web.sh            # 完整部署
#   ./deploy_web.sh --web      # 仅更新静态 Web
#   ./deploy_web.sh --relay    # 仅更新 relay（上传 + 重启服务）
#   ./deploy_web.sh --ng       # 仅上传 nginx conf 并 reload
#   ./deploy_web.sh --check    # 只做部署后验证
#
# 服务器与站点信息不写入本文件（本文件曾因此出库）：从
# apps/zcode-relay/deploy/deploy.env 读取（SERVER_HOST / SERVER_USER / SITE_URL，
# 该文件被 .gitignore 排除；缺失时也可用导出变量传入，同名变量以 env 文件优先）。

set -e

# 本脚本位于仓库根，部署资产（deploy.env / nginx conf / systemd unit）在 apps/zcode-relay/deploy/
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ASSETS_DIR="$PROJECT_ROOT/apps/zcode-relay/deploy"
RELAY_SRC="$DEPLOY_ASSETS_DIR/../dist/entry.js"
WEB_SRC="$PROJECT_ROOT/packages/web/dist"
SERVICE_SRC="$DEPLOY_ASSETS_DIR/zcode-relay.service"

ENV_FILE="${DEPLOY_ENV_FILE:-$DEPLOY_ASSETS_DIR/deploy.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
: "${SERVER_HOST:?缺少 SERVER_HOST（写入 $DEPLOY_ASSETS_DIR/deploy.env 或用导出变量传入）}"
: "${SITE_URL:?缺少 SITE_URL（公网入口，写入 $DEPLOY_ASSETS_DIR/deploy.env 或用导出变量传入）}"
SERVER_USER="${SERVER_USER:-root}"
RELAY_DIR="${RELAY_DIR:-/opt/zcode-relay}"
WEB_DIR="${WEB_DIR:-/var/www/zcode}"
RELAY_LOCAL_PORT="${RELAY_LOCAL_PORT:-8787}"
SITE_HOST_NO_SCHEME="${SITE_URL#https://}"
SITE_HOST_NO_SCHEME="${SITE_HOST_NO_SCHEME#http://}"
NGINX_CONF_SRC="$DEPLOY_ASSETS_DIR/$SITE_HOST_NO_SCHEME.conf"


BUILD_WEB=true
BUILD_RELAY=true
UPLOAD_NGINX=false
CHECK_ONLY=false
RELEASES=false
RELEASE_TARGETS="${RELEASE_TARGETS:-darwin-arm64 linux-x64}"
case "${1:-}" in
  --web)   BUILD_RELAY=false ;;
  --relay) BUILD_WEB=false ;;
  --ng)    BUILD_WEB=false; BUILD_RELAY=false; UPLOAD_NGINX=true ;;
  --release) BUILD_WEB=false; BUILD_RELAY=false; RELEASES=true ;;
  --check) BUILD_WEB=false; BUILD_RELAY=false; CHECK_ONLY=true ;;
esac

step() { printf '\n\033[0;34m========== %s ==========\033[0m\n' "$1"; }

if [ "$BUILD_WEB" = true ]; then
  step "构建静态 Web（隧道默认入口）"
  # 登录回跳受信 origin（specs/web-tunnel.md §5.7）：本部署注入自身 origin，
  # 覆盖回调落在本域的形态；跨域回跳生效仍需回调页所在部署（官方构建）注入本域。
  (cd "$PROJECT_ROOT" && VITE_TUNNEL_ENTRY=1 \
    VITE_TRUSTED_RETURN_ORIGINS="${VITE_TRUSTED_RETURN_ORIGINS:-$SITE_URL}" \
    pnpm --filter @zcode/web build)
fi

if [ "$BUILD_RELAY" = true ]; then
  step "构建 relay 单文件"
  (cd "$PROJECT_ROOT" && pnpm --filter @zcode/relay build)
fi

# 终端用户发行发布：多平台 stage 归档 + install.sh → 服务器 $DL_DIR，
# 供终端用户 curl 安装脚本使用（域名由 SITE_URL 决定，安装脚本本身随仓库分发）。
if [ "$RELEASES" = true ]; then
  step "构建并发布终端用户发行包（targets: $RELEASE_TARGETS）"
  DL_DIR="${DL_DIR:-/var/www/zcode-dl}"
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $DL_DIR"
  for target in $RELEASE_TARGETS; do
    (cd "$PROJECT_ROOT" && pnpm --filter @zcode/server-cli exec tsx src/packaging/stageCli.ts --target "$target")
    archive="$PROJECT_ROOT/packages/zcode-server-cli/dist-release/zcode-server-$target.tar.gz"
    [ -f "$archive" ] || { echo "archive missing: $archive" >&2; exit 1; }
    rsync -av --delete "$archive" "$SERVER_USER@$SERVER_HOST:$DL_DIR/zcode-server-$target.tar.gz"
    echo "[release] zcode-server-$target.tar.gz published"
  done
  rsync -av "$DEPLOY_ASSETS_DIR/install-zcode-server.sh" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.sh"
  rsync -av "$DEPLOY_ASSETS_DIR/install-zcode-server.ps1" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.ps1"
  rsync -av "$DEPLOY_ASSETS_DIR/install.cmd" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.cmd"
  echo "[release] install.sh / install.ps1 / install.cmd published"
fi

if [ "$CHECK_ONLY" != true ]; then
  step "上传到 $SERVER_USER@$SERVER_HOST"
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $RELAY_DIR $WEB_DIR"
  if [ "$BUILD_RELAY" = true ]; then
    rsync -av "$RELAY_SRC" "$SERVER_USER@$SERVER_HOST:$RELAY_DIR/"
    rsync -av "$SERVICE_SRC" "$SERVER_USER@$SERVER_HOST:/etc/systemd/system/"
    ssh "$SERVER_USER@$SERVER_HOST" "systemctl daemon-reload && systemctl enable --now zcode-relay && systemctl restart zcode-relay"
    echo "[服务器] relay 已部署并重启"
  fi
  if [ "$BUILD_WEB" = true ]; then
    rsync -av --delete "$WEB_SRC/" "$SERVER_USER@$SERVER_HOST:$WEB_DIR/"
    echo "[服务器] 静态 Web 已更新"
  fi
  # nginx conf 首次部署或 --ng 时上传（MD5 一致则跳过）
  LOCAL_MD5=$(md5 -q "$NGINX_CONF_SRC" 2>/dev/null || md5sum "$NGINX_CONF_SRC" | awk '{print $1}')
  REMOTE_MD5=$(ssh "$SERVER_USER@$SERVER_HOST" "md5sum /etc/nginx/conf.d/$(basename "$NGINX_CONF_SRC") 2>/dev/null | awk '{print \$1}'" || echo "")
  if [ "$LOCAL_MD5" != "$REMOTE_MD5" ]; then
    rsync -av "$NGINX_CONF_SRC" "$SERVER_USER@$SERVER_HOST:/etc/nginx/conf.d/$(basename "$NGINX_CONF_SRC")"
    ssh "$SERVER_USER@$SERVER_HOST" "nginx -t && nginx -s reload"
    echo "[服务器] nginx conf 已更新并 reload"
  else
    echo "nginx conf 无变化，跳过"
  fi
fi

step "验证"
ssh "$SERVER_USER@$SERVER_HOST" "systemctl is-active zcode-relay && curl -s -o /dev/null -w 'relay(本机): %{http_code}\n' -X POST http://127.0.0.1:$RELAY_LOCAL_PORT/api/v1/pair -H 'content-type: application/json' -d '{}'"
curl -s -o /dev/null -w "$SITE_URL 首页: %{http_code}\n" "$SITE_URL/" || true
curl -s -o /dev/null -w "$SITE_URL/relay 控制面: %{http_code}\n" -X POST "$SITE_URL/relay/api/v1/pair" -H 'content-type: application/json' -d '{}' || true
echo ""
echo "完成。宿主接入：zcode tunnel-enable --relay-url wss://$SITE_HOST_NO_SCHEME/relay"
