#!/bin/bash
# ZCode Web 隧道一键部署。
# 模型：本机构建 + rsync 产物（ZCode monorepo 不适合在服务器上构建）。
# 产物：静态 Web（/var/www/zcode）+ relay 单文件（/opt/zcode-relay）+ 日报脚本与 timer + nginx conf + systemd unit。
# 平滑发布：relay 产物与 unit 内容未变化时自动跳过重启（restart 会断开所有隧道 WS），
# nginx conf 一致时同样跳过；只有内容真正变化才重启。
# 用法：
#   ./deploy_web.sh            # 完整部署（含终端用户 CLI 发行包：自动检测变更，有变化才发布）
#   ./deploy_web.sh --web      # 仅更新静态 Web
#   ./deploy_web.sh --relay    # 仅更新 relay（上传 + 重启服务）
#   ./deploy_web.sh --ng       # 仅上传 nginx conf 并 reload
#   ./deploy_web.sh --desktop [dmg|exe ...]
#                             # 仅上传桌面版安装包到 $DL_DIR/desktop/（文件名固定为
#                             # ZCode-latest-*.dmg/.exe，必须与 packages/shared/src/desktopDownload.ts
#                             # 的 DESKTOP_DOWNLOAD_PATHS 一致；带文件参数时按扩展名归类，
#                             # 缺省自动取 packages/desktop/dist 里最新的 mac-arm64 dmg 与 win-x64 exe；
#                             # 某平台产物缺失时跳过该平台，一个都找不到才报错）
#   ./deploy_web.sh --cli [target ...]
#                             # 仅处理终端用户 CLI 发行包（server-cli 归档 + catalog + install.sh/ps1/cmd，
#                             # 上传到 $DL_DIR，供 curl 安装与已装宿主自动更新；target 缺省
#                             # darwin-arm64 + win32-x64，等价 RELEASE_TARGETS 环境变量）
#   ./deploy_web.sh --check    # 只做部署后验证
#
# CLI 发行包发布（原 ./deploy_cli.sh，已并入本脚本）：完整部署与 --cli 模式会先 stage 构建
# 各 target 归档，再与服务器上同名产物做联合 MD5 比对（含 catalog 与三个安装脚本），完全一致
# 则整段跳过上传——与下方 relay / nginx conf 的无变化跳过同策略，避免每次完整部署重复传输
# 上百 MB 归档；细粒度模式（--web / --relay / --ng / --desktop / --check）不触发 CLI 段。
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
DESKTOP_RELEASE=false
CLI_ONLY=false
# --desktop / --cli 之后的参数分别视为待上传安装包文件与发布平台；这两种模式不构建 Web、不重启服务。
if [ "${1:-}" = "--desktop" ]; then
  DESKTOP_RELEASE=true
  BUILD_WEB=false
  BUILD_RELAY=false
  shift
elif [ "${1:-}" = "--cli" ]; then
  CLI_ONLY=true
  BUILD_WEB=false
  BUILD_RELAY=false
  shift
fi
RELEASE_FILES=("$@")
case "${1:-}" in
  --web)   BUILD_RELAY=false ;;
  --relay) BUILD_WEB=false ;;
  --ng)    BUILD_WEB=false; BUILD_RELAY=false; UPLOAD_NGINX=true ;;
  --check) BUILD_WEB=false; BUILD_RELAY=false; CHECK_ONLY=true ;;
esac
# CLI 发行包段只在完整部署（无任何模式参数）与 --cli 模式运行；其余细粒度模式一律跳过。
CLI_ENABLED=false
if [ "$CLI_ONLY" = true ]; then
  CLI_ENABLED=true
elif [ -z "${1:-}" ] && [ "$DESKTOP_RELEASE" = false ]; then
  CLI_ENABLED=true
fi

step() { printf '\n\033[0;34m========== %s ==========\033[0m\n' "$1"; }

if [ "$CLI_ENABLED" = true ]; then
  # 发布平台：--cli 位置参数 > RELEASE_TARGETS 环境变量 > 默认（darwin-arm64 + win32-x64）。
  # darwin-x64 / linux / win32-arm64 当前无宿主用户，默认不发；需要时显式传参补发。
  CLI_RELEASE_TARGETS="${*:-${RELEASE_TARGETS:-darwin-arm64 win32-x64}}"
  # fork 禁区护栏（原 deploy_cli.sh 首步）：发行包含 agent 运行时（apps/zcode-cli），
  # 基线外的新增禁区改动直接终止发布。基线只减不增，例外走 scripts/fork-diff-baseline.json
  # 的评审更新（scripts/check-fork-diff.mjs）。
  step "fork diff 检查"
  (cd "$PROJECT_ROOT" && node scripts/check-fork-diff.mjs)
fi

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
  # 每日运营日报单文件（specs/web-daily-report.md）：与 relay 同源构建，独立部署（oneshot，无需重启）。
  (cd "$PROJECT_ROOT" && pnpm --filter @zcode/relay build:report)
fi

# 桌面版安装包发布：Web 端「下载桌面版」弹窗打开的就是这两个固定名直链。
# 文件名与 packages/shared/src/desktopDownload.ts 的 DESKTOP_DOWNLOAD_PATHS 严格对齐，
# 改名必须两处同步（UI 侧单测锁定了路径，避免只改一边导致 404）。
if [ "$DESKTOP_RELEASE" = true ]; then
  step "上传桌面版安装包"
  DL_DIR="${DL_DIR:-/var/www/zcode-dl}"
  DESKTOP_DIST_DIR="$PROJECT_ROOT/packages/desktop/dist"
  MAC_SRC=""
  WIN_SRC=""
  for file in "${RELEASE_FILES[@]:-}"; do
    [ -n "$file" ] || continue
    case "$file" in
      *.dmg) MAC_SRC="$file" ;;
      *.exe) WIN_SRC="$file" ;;
      *) echo "忽略无法归类的文件（仅接受 .dmg / .exe）: $file" >&2 ;;
    esac
  done
  # 未传参的平台自动取 dist 里最新产物；本机只构建了一个平台时允许部分发布。
  if [ -z "$MAC_SRC" ]; then
    MAC_SRC="$(ls -t "$DESKTOP_DIST_DIR"/*-mac-arm64.dmg 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$WIN_SRC" ]; then
    WIN_SRC="$(ls -t "$DESKTOP_DIST_DIR"/*-win-x64.exe 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$MAC_SRC" ] && [ -z "$WIN_SRC" ]; then
    echo "未找到桌面安装包：传入 .dmg/.exe 文件参数，或先构建出 packages/desktop/dist/*-mac-arm64.dmg 与 *-win-x64.exe" >&2
    exit 1
  fi
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $DL_DIR/desktop"
  if [ -n "$MAC_SRC" ]; then
    [ -f "$MAC_SRC" ] || { echo "Mac 安装包不存在: $MAC_SRC" >&2; exit 1; }
    rsync -av "$MAC_SRC" "$SERVER_USER@$SERVER_HOST:$DL_DIR/desktop/ZCode-latest-mac-arm64.dmg"
    echo "[desktop] Mac 包已发布：$SITE_URL/dl/desktop/ZCode-latest-mac-arm64.dmg"
    echo "[desktop]   sha256: $(shasum -a 256 "$MAC_SRC" | awk '{print $1}')"
  else
    echo "[desktop] 未提供 Mac 安装包，跳过（站点保留旧文件）"
  fi
  if [ -n "$WIN_SRC" ]; then
    [ -f "$WIN_SRC" ] || { echo "Windows 安装包不存在: $WIN_SRC" >&2; exit 1; }
    rsync -av "$WIN_SRC" "$SERVER_USER@$SERVER_HOST:$DL_DIR/desktop/ZCode-latest-win-x64.exe"
    echo "[desktop] Windows 包已发布：$SITE_URL/dl/desktop/ZCode-latest-win-x64.exe"
    echo "[desktop]   sha256: $(shasum -a 256 "$WIN_SRC" | awk '{print $1}')"
  else
    echo "[desktop] 未提供 Windows 安装包，跳过（站点保留旧文件）"
  fi
fi

# 终端用户 CLI 发行包（原 deploy_cli.sh，specs/web-tunnel.md）：stage 构建各 target 归档 +
# catalog.json（宿主自动更新源）+ install.sh/ps1/cmd 上传到 $DL_DIR。发布前把全部产物做
# 联合 MD5 与服务器比对（顺序固定，任一文件不一致或服务器缺文件即视为有变化），完全一致
# 则整段跳过上传。stage 每跑一个 target 就把条目按 target 合并进本地 catalog，最后整体上传。
if [ "$CLI_ENABLED" = true ]; then
  step "构建并检测终端用户 CLI 发行包（targets: $CLI_RELEASE_TARGETS）"
  # stageCli 只做归档打包，server-cli 自身的 tsup 产物（dist/server-cli.js）需要先构建。
  (cd "$PROJECT_ROOT" && pnpm --filter @zcode/server-cli build)
  CATALOG_FILE="$PROJECT_ROOT/packages/zcode-server-cli/dist-release/catalog.json"
  CLI_FILES=()
  CLI_REMOTE_NAMES=()
  for target in $CLI_RELEASE_TARGETS; do
    (cd "$PROJECT_ROOT" && pnpm --filter @zcode/server-cli exec tsx src/packaging/stageCli.ts \
      --target "$target" --catalog "$CATALOG_FILE" --catalog-archive-base-url "$SITE_URL/dl")
    archive="$PROJECT_ROOT/packages/zcode-server-cli/dist-release/zcode-server-$target.tar.gz"
    [ -f "$archive" ] || { echo "archive missing: $archive" >&2; exit 1; }
    CLI_FILES+=("$archive")
    CLI_REMOTE_NAMES+=("zcode-server-$target.tar.gz")
  done
  [ -f "$CATALOG_FILE" ] || { echo "catalog missing: $CATALOG_FILE" >&2; exit 1; }
  CLI_FILES+=("$CATALOG_FILE" \
    "$DEPLOY_ASSETS_DIR/install-zcode-server.sh" \
    "$DEPLOY_ASSETS_DIR/install-zcode-server.ps1" \
    "$DEPLOY_ASSETS_DIR/install.cmd")
  CLI_REMOTE_NAMES+=("catalog.json" "install.sh" "install.ps1" "install.cmd")

  # 联合 MD5（macOS md5 与 Linux md5sum 对同一字节流结果一致）。
  CLI_LOCAL_MD5=$(cat "${CLI_FILES[@]}" | md5 -q 2>/dev/null || cat "${CLI_FILES[@]}" | md5sum | awk '{print $1}')
  CLI_REMOTE_LIST=""
  for name in "${CLI_REMOTE_NAMES[@]}"; do
    CLI_REMOTE_LIST+=" $DL_DIR/$name"
  done
  CLI_REMOTE_MD5=$(ssh "$SERVER_USER@$SERVER_HOST" "cat${CLI_REMOTE_LIST} 2>/dev/null | md5sum | awk '{print \$1}'" || echo "")
  if [ "$CLI_LOCAL_MD5" = "$CLI_REMOTE_MD5" ]; then
    echo "[release] CLI 发行包无变化，跳过上传（catalog：$SITE_URL/dl/catalog.json）"
  else
    ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $DL_DIR"
    CLI_INDEX=0
    for name in "${CLI_REMOTE_NAMES[@]}"; do
      rsync -av "${CLI_FILES[$CLI_INDEX]}" "$SERVER_USER@$SERVER_HOST:$DL_DIR/$name"
      CLI_INDEX=$((CLI_INDEX + 1))
    done
    echo "[release] zcode-server-*.tar.gz / catalog.json / install.sh|ps1|cmd 已发布"
    echo "[release] 宿主自动更新源：$SITE_URL/dl/catalog.json"
  fi
fi

if [ "$CHECK_ONLY" != true ]; then
  step "上传到 $SERVER_USER@$SERVER_HOST"
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $RELAY_DIR $WEB_DIR"
  if [ "$BUILD_RELAY" = true ]; then
    # 平滑发布：relay 产物与 systemd unit 均未变化时跳过上传与重启。restart 会立刻
    # 断开所有隧道 WS（宿主连接器与浏览器），而绝大多数提交不触碰 relay（esbuild
    # 产物随 @zcode/shared 变化，故以内容哈希而非 git 路径判定）。与下方 nginx conf
    # 的 MD5 跳过同策略。
    LOCAL_ENTRY_MD5=$(md5 -q "$RELAY_SRC" 2>/dev/null || md5sum "$RELAY_SRC" | awk '{print $1}')
    LOCAL_UNIT_MD5=$(md5 -q "$SERVICE_SRC" 2>/dev/null || md5sum "$SERVICE_SRC" | awk '{print $1}')
    REMOTE_ENTRY_MD5=$(ssh "$SERVER_USER@$SERVER_HOST" "md5sum $RELAY_DIR/entry.js 2>/dev/null | awk '{print \$1}'" || echo "")
    REMOTE_UNIT_MD5=$(ssh "$SERVER_USER@$SERVER_HOST" "md5sum /etc/systemd/system/$(basename "$SERVICE_SRC") 2>/dev/null | awk '{print \$1}'" || echo "")
    if [ "$LOCAL_ENTRY_MD5" = "$REMOTE_ENTRY_MD5" ] && [ "$LOCAL_UNIT_MD5" = "$REMOTE_UNIT_MD5" ]; then
      # daemon-reload / enable --now 对运行中的服务是无操作；仅当服务意外退出时被拉起。
      ssh "$SERVER_USER@$SERVER_HOST" "systemctl daemon-reload && systemctl enable --now zcode-relay"
      echo "[服务器] relay 产物无变化，跳过重启（不断开现有隧道连接）"
    else
      rsync -av "$RELAY_SRC" "$SERVER_USER@$SERVER_HOST:$RELAY_DIR/"
      rsync -av "$SERVICE_SRC" "$SERVER_USER@$SERVER_HOST:/etc/systemd/system/"
      ssh "$SERVER_USER@$SERVER_HOST" "systemctl daemon-reload && systemctl enable --now zcode-relay && systemctl restart zcode-relay"
      echo "[服务器] relay 产物有变化，已部署并重启"
    fi
  fi
  # 每日运营日报（specs/web-daily-report.md）：统计脚本 + systemd timer + 飞书凭证（report.env）。
  # report.env 只在 deploy.env 三个飞书变量齐全时重写（0600）；缺项时保留服务器现状并提示。
  if [ "$BUILD_RELAY" = true ]; then
    step "部署每日运营日报（统计脚本 + systemd timer）"
    REPORT_SRC="$DEPLOY_ASSETS_DIR/../dist/daily-report.js"
    if [ ! -f "$REPORT_SRC" ]; then
      echo "缺少 $REPORT_SRC（构建失败？）" >&2
      exit 1
    fi
    rsync -av "$REPORT_SRC" "$SERVER_USER@$SERVER_HOST:$RELAY_DIR/"
    rsync -av "$DEPLOY_ASSETS_DIR/zcode-daily-report.service" "$DEPLOY_ASSETS_DIR/zcode-daily-report.timer" \
      "$SERVER_USER@$SERVER_HOST:/etc/systemd/system/"
    if [ -n "${FEISHU_APP_ID:-}" ] && [ -n "${FEISHU_APP_SECRET:-}" ] && [ -n "${FEISHU_NOTIFY_USER_ID:-}" ]; then
      printf 'FEISHU_APP_ID=%s\nFEISHU_APP_SECRET=%s\nFEISHU_NOTIFY_USER_ID=%s\n' \
        "$FEISHU_APP_ID" "$FEISHU_APP_SECRET" "$FEISHU_NOTIFY_USER_ID" \
        | ssh "$SERVER_USER@$SERVER_HOST" "umask 077 && cat > $RELAY_DIR/report.env"
      echo "[服务器] report.env 已更新（飞书凭证，0600）"
    else
      echo "[提示] deploy.env 缺 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_NOTIFY_USER_ID，日报将只聚合不发送"
    fi
    ssh "$SERVER_USER@$SERVER_HOST" "systemctl daemon-reload && systemctl enable --now zcode-daily-report.timer"
    echo "[服务器] 日报 timer 已启用（每日 23:00 服务器本地时间）"
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
# 日报 timer 只在 --relay 部署路径安装；纯 --web/--ng/--check 部署时提示而非失败。
ssh "$SERVER_USER@$SERVER_HOST" "systemctl is-active zcode-daily-report.timer 2>/dev/null || echo '日报 timer 未启用（跑一次 ./deploy_web.sh 或 --relay 后生效）'" || true
curl -s -o /dev/null -w "$SITE_URL 首页: %{http_code}\n" "$SITE_URL/" || true
curl -s -o /dev/null -w "$SITE_URL/relay 控制面: %{http_code}\n" -X POST "$SITE_URL/relay/api/v1/pair" -H 'content-type: application/json' -d '{}' || true
# CLI 发行包公网拉取验证（原 deploy_cli.sh 末段）。失败只提示不中断——下载由 nginx 直出，
# 这里不可达也可能是本机网络问题，不应据此回滚已上传的产物。
if [ "$CLI_ENABLED" = true ]; then
  curl -s -o /dev/null -w "$SITE_URL/dl/catalog.json: %{http_code}\n" "$SITE_URL/dl/catalog.json" || true
  curl -s -o /dev/null -w "$SITE_URL/install.sh: %{http_code}\n" "$SITE_URL/install.sh" || true
fi
echo ""
echo "完成。宿主接入：zcode tunnel-enable --relay-url wss://$SITE_HOST_NO_SCHEME/relay"
