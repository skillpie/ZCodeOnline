#!/bin/bash
# 桌面版两端构建并发布：构建 mac-arm64 / win-x64 安装包后，委托 deploy_web.sh --desktop
# 上传到服务器 $DL_DIR/desktop/（固定名 ZCode-latest-*.dmg/.exe，站点「下载桌面版」直链，
# 与 packages/shared/src/desktopDownload.ts 的 DESKTOP_DOWNLOAD_PATHS 对齐）。
# 只做构建 + 上传，不重启任何服务。
# 用法：
#   ./deploy_desktop.sh            # 构建 mac-arm64 + win-x64 两端并上传
#   ./deploy_desktop.sh --mac      # 仅构建并上传 mac-arm64
#   ./deploy_desktop.sh --win      # 仅构建并上传 win-x64
#
# 说明：
# - 构建用正式身份（ZCODE_ENV=production，不带 ZCODE_PREVIEW_IDENTITY）；本机自装
#   预览包用 ./install_desktop.sh，别用本脚本，否则站点会拿到 Preview 身份的包。
# - 任一端构建失败即中止，不上传任何产物；需要单端补发用 --mac / --win。
# - 服务器信息由 deploy_web.sh 自行从 apps/zcode-relay/deploy/deploy.env 读取。

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIST_DIR="$PROJECT_ROOT/packages/desktop/dist"

BUILD_MAC=false
BUILD_WIN=false
case "${1:-}" in
  "")     BUILD_MAC=true; BUILD_WIN=true ;;
  --mac)  BUILD_MAC=true ;;
  --win)  BUILD_WIN=true ;;
  -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "未知参数: $1（支持 --mac / --win / -h）" >&2; exit 1 ;;
esac

step() { printf '\n\033[0;34m========== %s ==========\033[0m\n' "$1"; }

MAC_SRC=""
WIN_SRC=""

if [ "$BUILD_MAC" = true ]; then
  step "构建 macOS（arm64）安装包"
  (cd "$PROJECT_ROOT" && ZCODE_ENV=production pnpm bundle:desktop -- --os mac --arch arm64)
  MAC_SRC="$(ls -t "$DESKTOP_DIST_DIR"/*-mac-arm64.dmg 2>/dev/null | head -1 || true)"
  [ -n "$MAC_SRC" ] || { echo "未找到 mac-arm64 DMG 产物（$DESKTOP_DIST_DIR）" >&2; exit 1; }
  echo "[desktop] 产物: $MAC_SRC"
fi

if [ "$BUILD_WIN" = true ]; then
  step "构建 Windows（x64）安装包"
  # NSIS target 支持在 macOS 交叉构建；如需在 Windows 机器出包，在那边构建后
  # 直接 deploy_web.sh --desktop <exe> 上传。
  (cd "$PROJECT_ROOT" && ZCODE_ENV=production pnpm bundle:desktop -- --os win --arch x64)
  WIN_SRC="$(ls -t "$DESKTOP_DIST_DIR"/*-win-x64.exe 2>/dev/null | head -1 || true)"
  [ -n "$WIN_SRC" ] || { echo "未找到 win-x64 EXE 产物（$DESKTOP_DIST_DIR）" >&2; exit 1; }
  echo "[desktop] 产物: $WIN_SRC"
fi

# 显式把刚构建的文件传给 deploy_web.sh --desktop，而不是让它 auto-pick dist 里
# 最新的产物——避免单端发布时误传另一端的陈旧文件。未选中的端不上传，站点保留旧文件。
step "上传桌面版安装包"
FILES=()
[ -n "$MAC_SRC" ] && FILES+=("$MAC_SRC")
[ -n "$WIN_SRC" ] && FILES+=("$WIN_SRC")
exec bash "$PROJECT_ROOT/deploy_web.sh" --desktop "${FILES[@]}"
