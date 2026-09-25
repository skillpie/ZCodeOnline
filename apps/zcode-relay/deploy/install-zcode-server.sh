#!/bin/sh
# ZCode Server 一键安装（specs/web-tunnel.md §5.7）—— macOS / Linux。
# （Windows 用 install.ps1 / install.cmd，见 DEPLOY.md）
# 标准形态（平台自动探测 + 从本站下载）：
#   curl -fsSL https://zcode.skillpie.cn/install.sh | sh
# 等价显式形式：
#   install-zcode-server.sh [--base-url <url>] [--install-dir <dir>] [--workspace <dir>] [--start]
# 离线/自托管归档：
#   install-zcode-server.sh --archive <file.tar.gz> [同上]
#
# 默认行为：安装 → 注册常驻服务（开机自启）→ 立即启动，并打印远程控制链接。
# --no-start 仅安装不启动；模型账号登录可在浏览器界面左下角完成（可选）。
# 首次配对/日常使用：zcode status 查看；浏览器打开打印的 https://zcode.skillpie.cn/<码>。

set -e

DEFAULT_BASE_URL="https://zcode.skillpie.cn/dl"
BASE_URL=""
ARCHIVE=""
INSTALL_DIR="/opt/zcode-server"
WORKSPACE=""
START=true

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --start) START=true; shift ;;
    --no-start) START=false; shift ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- 平台探测：darwin/linux × arm64/x64（归档命名 = stage 的 target） ----
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Darwin) OS_NAME="darwin" ;;
  Linux) OS_NAME="linux" ;;
  *) echo "[install] unsupported OS: $OS (macOS/Linux only)" >&2; exit 1 ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH_NAME="arm64" ;;
  x86_64|amd64) ARCH_NAME="x64" ;;
  *) echo "[install] unsupported arch: $ARCH" >&2; exit 1 ;;
esac
TARGET="$OS_NAME-$ARCH_NAME"

if [ -z "$BASE_URL" ]; then
  BASE_URL="$DEFAULT_BASE_URL"
fi

# ---- 安装目录：系统级用 /opt，无 root 时回退用户目录 ----
if [ ! -w "$(dirname "$INSTALL_DIR")" ] && [ "$(id -u)" != "0" ]; then
  INSTALL_DIR="$HOME/.zcode-server"
  echo "[install] no permission for default dir, using $INSTALL_DIR"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$TMP/zcode-server-$TARGET.tar.gz"
  echo "[install] downloading release for $TARGET from $BASE_URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE_URL/zcode-server-$TARGET.tar.gz" -o "$ARCHIVE" || {
      echo "[install] ERROR: release download failed ($TARGET). Is it published on $BASE_URL?" >&2
      exit 1
    }
  else
    wget -qO "$ARCHIVE" "$BASE_URL/zcode-server-$TARGET.tar.gz" || {
      echo "[install] ERROR: release download failed ($TARGET)." >&2
      exit 1
    }
  fi
fi

echo "[install] extracting to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xf "$ARCHIVE" -C "$INSTALL_DIR"

# stage 归档内层为 zcode-server-<target>/；兼容两种布局
if [ ! -x "$INSTALL_DIR/bin/zcode" ] && ls "$INSTALL_DIR"/zcode-server-*/bin/zcode >/dev/null 2>&1; then
  mv "$INSTALL_DIR"/zcode-server-*/* "$INSTALL_DIR"/ 2>/dev/null || true
  rmdir "$INSTALL_DIR"/zcode-server-* 2>/dev/null || true
fi

if [ ! -x "$INSTALL_DIR/bin/zcode" ]; then
  echo "[install] ERROR: bin/zcode not found after extraction" >&2
  exit 1
fi

# ---- 工作区环境：写入安装目录 env 文件，serve 启动时读取 ----
if [ -n "$WORKSPACE" ]; then
  printf 'ZCODE_SERVER_WORKSPACE=%s\n' "$WORKSPACE" > "$INSTALL_DIR/env"
  echo "[install] workspace: $WORKSPACE (edit $INSTALL_DIR/env to change)"
fi

# ---- PATH symlink ----
LINK_DIR=""
for candidate in /usr/local/bin "$HOME/.local/bin" /opt/homebrew/bin; do
  if [ -d "$candidate" ] && [ -w "$candidate" ]; then LINK_DIR="$candidate"; break; fi
done
if [ -z "$LINK_DIR" ]; then
  mkdir -p "$HOME/.local/bin"
  LINK_DIR="$HOME/.local/bin"
  case ":$PATH:" in
    *":$LINK_DIR:"*) ;;
    *) echo "[install] NOTE: add $LINK_DIR to your PATH" ;;
  esac
fi
ln -sf "$INSTALL_DIR/bin/zcode" "$LINK_DIR/zcode"
echo "[install] zcode -> $LINK_DIR/zcode"

# systemd 环境注入（linux）：service 由 serve 自注册，drop-in 指向安装目录 env
if [ -n "$WORKSPACE" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p /etc/systemd/system/zcode-server.service.d 2>/dev/null || true
  printf '[Service]\nEnvironmentFile=%s\n' "$INSTALL_DIR/env" \
    > /etc/systemd/system/zcode-server.service.d/workspace.conf 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
fi

echo "[install] done."

if [ "$START" = true ]; then
  echo "[install] registering boot-persistent service and starting..."
  "$INSTALL_DIR/bin/zcode" serve --daemon > "$TMP/serve.out" 2>&1
  # 轮询 ready + Remote access（core 启动后异步生成机器码）
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if grep -q "Remote access" "$TMP/serve.out" 2>/dev/null; then break; fi
    sleep 1
  done
  grep -E "ZCode Server ready|Remote access" "$TMP/serve.out" 2>/dev/null || true
  echo "[install] 服务已注册为开机自启；电脑重启后会自动恢复，链接不变。"
else
  echo "[install] --no-start: 仅安装。稍后运行 zcode serve 启动。"
fi
