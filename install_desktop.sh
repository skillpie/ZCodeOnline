#!/bin/bash
# 打包桌面端（ZCodeOnline Preview 身份，生产后端）并替换安装到本机 /Applications。
#
# 用法：
#   ./install_desktop.sh                # 构建 + 重装
#   ./install_desktop.sh --skip-build   # 跳过构建，使用 dist 里现有的 ZCodeOnline DMG 重装
#
# 注意：
# - 启动后自动转入后台执行，前台只跟随日志；会话中断（如桌面 app 被退出）不影响安装完成。
# - 运行会退出正在运行的 ZCodeOnline 并替换应用。替换需要 macOS「应用管理」权限：
#   桌面会话继承 app 自身授权可直接执行；Web 会话（daemon）或终端需先在
#   系统设置 → 隐私与安全性 → 应用管理 中授权对应进程。
# - 产物未签名；重启后若被 Gatekeeper 拦截，右键图标选「打开」一次即可。
# - 正式版 /Applications/ZCode.app 不受影响（Preview 身份可与正式版并排）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# worker 重新拉起必须用绝对路径：`sh install_desktop.sh` 这类不带 ./ 的调用里
# $0 无斜杠，exec 只查 PATH 不查当前目录，会静默找不到脚本。
SELF_PATH="$SCRIPT_DIR/$(basename "$0")"
DMG_DIR="$SCRIPT_DIR/packages/desktop/dist"
APP_PATH="/Applications/ZCodeOnline.app"
LOG_DIR="$HOME/.zcode/logs"
LOG_FILE="$LOG_DIR/desktop-install.log"

SKIP_BUILD=false
case "${1:-}" in
  "") ;;
  --skip-build) SKIP_BUILD=true ;;
  -h|--help) sed -n '1,/^set -euo pipefail$/p' "$0" | grep '^#' | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "未知参数: $1（支持 --skip-build / -h）"; exit 1 ;;
esac

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

# 桌面会话里执行时，"退出正在运行的 ZCodeOnline" 会连带杀掉脚本所在进程树，
# 安装会停在替换之前（2026-10-08 实测：日志止于退出步骤，/Applications 仍是旧包）。
# 这里把真正的安装流程交给脱离会话的后台 worker：前台只跟随日志，app 退出只中断
# 跟随、不影响安装；worker 落在新会话（macOS 无 setsid 命令，用 perl POSIX::setsid）
# 并忽略 HUP/INT/TERM——替换是原子性要求，一旦开始必须走到完成，半途退出会留下残缺 app。
if [ "${ZCODE_INSTALL_DESKTOP_DETACHED:-}" != "1" ]; then
  touch "$LOG_FILE"
  echo "安装已在后台执行，实时日志: tail -f $LOG_FILE"
  # worker 的 stderr 落进安装日志（exec 失败等错误可见），stdout 丢弃避免与 log() 的
  # tee 双写；exec 失败必须 die 透传非零退出码，否则 perl 会静默以 0 结束。
  if command -v perl >/dev/null 2>&1; then
    ZCODE_INSTALL_DESKTOP_DETACHED=1 nohup perl -MPOSIX=setsid -e 'setsid or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$SELF_PATH" "$@" >/dev/null 2>>"$LOG_FILE" </dev/null &
  else
    # 无 perl 的环境退化为仅屏蔽 HUP：防会话正常终止，防不了整组 SIGKILL。
    ZCODE_INSTALL_DESKTOP_DETACHED=1 nohup "$SELF_PATH" "$@" >/dev/null 2>>"$LOG_FILE" </dev/null &
  fi
  worker_pid=$!
  tail -n 40 -f "$LOG_FILE" &
  tail_pid=$!
  trap 'kill "$tail_pid" 2>/dev/null || true' EXIT
  status=0
  wait "$worker_pid" || status=$?
  exit "$status"
fi
# worker 模式：会话终止信号不影响安装；如需人工中止用 kill -9。
trap '' HUP INT TERM
log "后台 worker 已启动（pid $$，独立会话）"

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
