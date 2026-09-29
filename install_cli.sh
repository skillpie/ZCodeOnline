#!/bin/bash
# 重建本机宿主 daemon（zcode-server-cli）并重启，让 zcode.skillpie.cn 的网页会话用上新 Agent 产物。
#
# 背景：post-commit 钩子只自动部署静态 Web；改动 apps/zcode-cli 或
# packages/zcode-server-cli 后 daemon 不会自己重建，网页会话会一直跑旧产物。
# daemon dev 态经 findUpward 定位 apps/zcode-cli/packages/cli/dist/zcode.cjs，
# 因此两个产物都要重建。
#
# 用法：
#   ./install_cli.sh                 # 构建 @zcode/cli + @zcode/server-cli，然后重启 daemon
#   ./install_cli.sh --skip-build    # 跳过构建，直接重启（复用现有 dist 产物）
#   ./install_cli.sh --no-restart    # 只构建不重启（daemon 有运行中任务时先构建，稍后自行重启）
#
# 注意：重启会中断 daemon 上运行中的网页会话任务（含 zcode status 里 runningTaskCount 未完成的）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

SERVER_CLI="$HOME/.zcode/server/bin/zcode"

SKIP_BUILD=false
NO_RESTART=false
case "${1:-}" in
  "") ;;
  --skip-build) SKIP_BUILD=true ;;
  --no-restart) NO_RESTART=true ;;
  -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "未知参数: $1（支持 --skip-build / --no-restart / -h）"; exit 1 ;;
esac

step() { printf '\n\033[0;34m========== %s ==========\033[0m\n' "$1"; }

if [ "$SKIP_BUILD" = false ]; then
  step "构建 Agent 运行时（@zcode/cli → apps/zcode-cli/packages/cli/dist/zcode.cjs）"
  pnpm --filter @zcode/cli build

  step "构建宿主 daemon（@zcode/server-cli → packages/zcode-server-cli/dist/）"
  pnpm --filter @zcode/server-cli build
fi

if [ "$NO_RESTART" = false ]; then
  if [ ! -x "$SERVER_CLI" ]; then
    echo "未找到宿主 daemon 启动器 $SERVER_CLI；本机可能尚未安装 zcode-server。" >&2
    exit 1
  fi
  step "重启宿主 daemon（运行中的网页会话任务会被中断）"
  "$SERVER_CLI" restart
  "$SERVER_CLI" status
fi
