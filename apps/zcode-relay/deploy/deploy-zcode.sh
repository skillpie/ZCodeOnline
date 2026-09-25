#!/bin/bash
# ZCode Web 隧道一键部署（目标：skillpie 服务器 106.53.164.221 → zcode.skillpie.cn）
# 模型：本机构建 + rsync 产物（ZCode monorepo 不适合在服务器上构建）。
# 产物：静态 Web（/var/www/zcode）+ relay 单文件（/opt/zcode-relay）+ nginx conf + systemd unit。
# 用法：
#   ./deploy-zcode.sh            # 完整部署
#   ./deploy-zcode.sh --web      # 仅更新静态 Web
#   ./deploy-zcode.sh --relay    # 仅更新 relay（上传 + 重启服务）
#   ./deploy-zcode.sh --ng       # 仅上传 nginx conf 并 reload
#   ./deploy-zcode.sh --check    # 只做部署后验证

set -e

# 脚本位于 apps/zcode-relay/deploy/，仓库根在三级之上
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DEPLOY_DIR/../../.." && pwd)"
RELAY_SRC="$DEPLOY_DIR/../dist/entry.js"
WEB_SRC="$PROJECT_ROOT/packages/web/dist"
NGINX_CONF_SRC="$DEPLOY_DIR/zcode.skillpie.cn.conf"
SERVICE_SRC="$DEPLOY_DIR/zcode-relay.service"

SERVER_HOST="${SERVER_HOST:-106.53.164.221}"
SERVER_USER="${SERVER_USER:-root}"
RELAY_DIR="/opt/zcode-relay"
WEB_DIR="/var/www/zcode"


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
  (cd "$PROJECT_ROOT" && VITE_TUNNEL_ENTRY=1 pnpm --filter @zcode/web build)
fi

if [ "$BUILD_RELAY" = true ]; then
  step "构建 relay 单文件"
  (cd "$PROJECT_ROOT" && pnpm --filter @zcode/relay build)
fi

# 终端用户发行发布：多平台 stage 归档 + install.sh → 服务器 /var/www/zcode-dl/，
# 供 curl -fsSL https://zcode.skillpie.cn/install.sh | sh 使用。
if [ "$RELEASES" = true ]; then
  step "构建并发布终端用户发行包（targets: $RELEASE_TARGETS）"
  DL_DIR="/var/www/zcode-dl"
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $DL_DIR"
  for target in $RELEASE_TARGETS; do
    (cd "$PROJECT_ROOT" && pnpm --filter @zcode/server-cli exec tsx src/packaging/stageCli.ts --target "$target")
    archive="$PROJECT_ROOT/packages/zcode-server-cli/dist-release/zcode-server-$target.tar.gz"
    [ -f "$archive" ] || { echo "archive missing: $archive" >&2; exit 1; }
    rsync -av --delete "$archive" "$SERVER_USER@$SERVER_HOST:$DL_DIR/zcode-server-$target.tar.gz"
    echo "[release] zcode-server-$target.tar.gz published"
  done
  rsync -av "$DEPLOY_DIR/install-zcode-server.sh" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.sh"
  rsync -av "$DEPLOY_DIR/install-zcode-server.ps1" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.ps1"
  rsync -av "$DEPLOY_DIR/install.cmd" "$SERVER_USER@$SERVER_HOST:$DL_DIR/install.cmd"
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
  REMOTE_MD5=$(ssh "$SERVER_USER@$SERVER_HOST" "md5sum /etc/nginx/conf.d/zcode.skillpie.cn.conf 2>/dev/null | awk '{print \$1}'" || echo "")
  if [ "$LOCAL_MD5" != "$REMOTE_MD5" ]; then
    rsync -av "$NGINX_CONF_SRC" "$SERVER_USER@$SERVER_HOST:/etc/nginx/conf.d/zcode.skillpie.cn.conf"
    ssh "$SERVER_USER@$SERVER_HOST" "nginx -t && nginx -s reload"
    echo "[服务器] nginx conf 已更新并 reload"
  else
    echo "nginx conf 无变化，跳过"
  fi
fi

step "验证"
ssh "$SERVER_USER@$SERVER_HOST" "systemctl is-active zcode-relay && curl -s -o /dev/null -w 'relay(本机): %{http_code}\n' -X POST http://127.0.0.1:8787/api/v1/pair -H 'content-type: application/json' -d '{}'"
curl -s -o /dev/null -w "https://zcode.skillpie.cn 首页: %{http_code}\n" https://zcode.skillpie.cn/ || true
curl -s -o /dev/null -w "https://zcode.skillpie.cn/relay 控制面: %{http_code}\n" -X POST https://zcode.skillpie.cn/relay/api/v1/pair -H 'content-type: application/json' -d '{}' || true
echo ""
echo "完成。宿主接入：zcode tunnel-enable --relay-url wss://zcode.skillpie.cn/relay"
