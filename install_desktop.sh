#!/bin/bash
# 打包桌面端（ZCodeOnline Preview 身份，生产后端）并替换安装到本机 /Applications。
#
# 用法：
#   ./install_desktop.sh                # 构建 + 重装
#   ./install_desktop.sh --skip-build   # 跳过构建，使用 dist 里现有的 ZCodeOnline DMG 重装
#
# 注意：
# - 运行会退出正在运行的 ZCodeOnline 并替换应用；如果本脚本是在 ZCode 会话里执行的，
#   该会话会随应用退出而中断，安装仍会继续完成。
# - 产物未签名；重启后若被 Gatekeeper 拦截，右键图标选「打开」一次即可。
# - 正式版 /Applications/ZCode.app 不受影响（Preview 身份可与正式版并排）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DMG_DIR="$SCRIPT_DIR/packages/desktop/dist"
APP_PATH="/Applications/ZCodeOnline.app"
LOG_DIR="$HOME/.zcode/logs"
LOG_FILE="$LOG_DIR/desktop-install.log"

SKIP_BUILD=false
case "${1:-}" in
  "") ;;
  --skip-build) SKIP_BUILD=true ;;
  -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "未知参数: $1（支持 --skip-build / -h）"; exit 1 ;;
esac

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

if [ "$SKIP_BUILD" = false ]; then
  log "构建桌面端（ZCodeOnline Preview，生产后端）..."
  # 构建输出全量进日志；pipefail 保证 pnpm 失败会传导，禁止带旧包继续安装。
  # ZCODE_ENV=production 必须显式携带：缺省会被 desktop-product-identity 按
  # fail-safe 视为测试后端，产物加 _TEST 后缀并连测试后端（与下行注释矛盾）。
  if ! (cd "$SCRIPT_DIR" && ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop) 2>&1 | tee -a "$LOG_FILE"; then
    log "构建失败，终止（未改动已安装应用）"
    exit 1
  fi
fi

DMG="$(ls -t "$DMG_DIR"/ZCodeOnline-*.dmg 2>/dev/null | head -1 || true)"
if [ -z "$DMG" ]; then
  log "未找到 DMG 产物（$DMG_DIR/ZCodeOnline-*.dmg），终止"
  exit 1
fi

# 只保留最新一份安装包：历史 DMG（旧版本/旧环境）构建后即清理，dist 永远只有当前包。
ls -t "$DMG_DIR"/ZCodeOnline-*.dmg 2>/dev/null | tail -n +2 | while read -r old_dmg; do
  rm -f "$old_dmg"
  log "已清理旧安装包: $(basename "$old_dmg")"
done
log "使用产物: $DMG"

# 清理历史残留挂载，避免 glob 命中旧卷。
hdiutil detach /Volumes/ZCodeOnline* 2>/dev/null || true

log "退出正在运行的 ZCodeOnline ..."
osascript -e 'tell application "ZCodeOnline" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  pgrep -x ZCodeOnline >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -x ZCodeOnline >/dev/null 2>&1; then
  log "优雅退出超时，强制结束"
  pkill -9 -x ZCodeOnline || true
  sleep 3
fi

log "替换 $APP_PATH ..."
rm -rf "$APP_PATH"
hdiutil attach -nobrowse -quiet "$DMG"
SRC_APP="$(ls -d /Volumes/ZCodeOnline*/ZCodeOnline.app 2>/dev/null | head -1 || true)"
if [ -z "$SRC_APP" ]; then
  log "DMG 内未找到 ZCodeOnline.app，终止"
  hdiutil detach /Volumes/ZCodeOnline* 2>/dev/null || true
  exit 1
fi
ditto "$SRC_APP" "$APP_PATH"
hdiutil detach "$(echo "$SRC_APP" | sed -E 's#(/Volumes/[^/]+).*#\1#')" -quiet || true

log "重新启动应用 ..."
open -a "$APP_PATH"

INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo unknown)"
log "完成：ZCodeOnline $INSTALLED_VERSION 已安装到 $APP_PATH"
