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
  echo "[install] downloading release for $TARGET from $BASE_URL (~70-90 MB)"
  # 进度条输出在 stderr，不影响 `curl ... | sh` 管道；-S 保证出错信息仍然可见。
  if command -v curl >/dev/null 2>&1; then
    curl -fS --progress-bar -L "$BASE_URL/zcode-server-$TARGET.tar.gz" -o "$ARCHIVE" || {
      echo "[install] ERROR: release download failed ($TARGET). Is it published on $BASE_URL?" >&2
      exit 1
    }
  else
    wget --progress=bar:force -O "$ARCHIVE" "$BASE_URL/zcode-server-$TARGET.tar.gz" || {
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
  # ---- 启动 + 自愈（specs/web-tunnel.md §5.9）----
  # serve --daemon 会替换同数据根上的旧 daemon，但可能被运行中任务拒绝；旧脚本
  # 此时仍打印成功，把静默失败留给用户。这里以发现端点实测为准，失败时自动收敛：
  # 先 zcode stop 优雅停（处理运行任务拒绝），再 pkill 强停残留 core，最后清
  # daemon 运行态目录重建（~/.zcode 下会话/登录数据不受影响）。三步后仍失败才报错，
  # 报错文案直接给出用户下一步动作。
  # 启动 daemon：展示行直写终端（绝不能与 $() 组合，否则展示文本会被当作返回值）。
  launch_daemon() {
    "$INSTALL_DIR/bin/zcode" serve --daemon > "$TMP/serve.out" 2>&1
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if grep -q "Remote access" "$TMP/serve.out" 2>/dev/null; then break; fi
      sleep 1
    done
    grep -E "ZCode Server ready|Remote access" "$TMP/serve.out" 2>/dev/null || true
  }

  # 查询发现端点：只输出码本身（供 $() 捕获）。
  query_assist_code() {
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 5 -H "Origin: https://zcode.skillpie.cn" \
        http://127.0.0.1:4950/tunnel/assist 2>/dev/null \
        | sed -n 's/.*"code":"\([0-9]*\)".*/\1/p'
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- -T 5 --header "Origin: https://zcode.skillpie.cn" \
        http://127.0.0.1:4950/tunnel/assist 2>/dev/null \
        | sed -n 's/.*"code":"\([0-9]*\)".*/\1/p'
    fi
  }

  echo "[install] registering boot-persistent service and starting..."
  launch_daemon
  assist_code=$(query_assist_code)
  if [ -n "$assist_code" ] && [ "${#assist_code}" -ne 8 ]; then
    # 16 位等异常码只可能来自旧版 daemon（新版 core 返回前有 8 位服务端校验）。
    echo "[install] 旧版 daemon 未被替换（返回 ${#assist_code} 位码），自动修复中…"
    "$INSTALL_DIR/bin/zcode" stop >/dev/null 2>&1 || true
    sleep 2
    launch_daemon
    assist_code=$(query_assist_code)
  fi
  if [ -n "$assist_code" ] && [ "${#assist_code}" -ne 8 ]; then
    echo "[install] 优雅停止后仍异常，强制结束残留 daemon 进程…"
    # 先杀 supervisor 再杀 core：只杀 core 会被存活的 supervisor 崩溃重启拉回
    # （supervisor 命令行含 server-cli.js，与桌面端 zcode-cli 进程不相交）。
    pkill -f "server-cli.js" >/dev/null 2>&1 || true
    sleep 1
    pkill -f "server-core.js" >/dev/null 2>&1 || true
    sleep 2
    launch_daemon
    assist_code=$(query_assist_code)
  fi
  if [ -n "$assist_code" ] && [ "${#assist_code}" -ne 8 ]; then
    echo "[install] 仍有旧运行态残留，重置 daemon 运行态目录（~/.zcode/server；会话与登录数据不受影响）…"
    rm -rf "$HOME/.zcode/server"
    launch_daemon
    assist_code=$(query_assist_code)
  fi
  if [ -n "$assist_code" ] && [ "${#assist_code}" -eq 8 ]; then
    echo "[install] 自检通过：发现端点返回 8 位远程码。"
    echo "[install] 服务已注册为开机自启；电脑重启后会自动恢复，链接不变。"
  else
    # 失败时把启动日志转移到持久位置（trap 会清理 $TMP，直接引用 serve.out 会
    # No such file or directory），供排障使用。
    cp "$TMP/serve.out" "$HOME/.zcode-install-serve.out" 2>/dev/null || true
    echo "[install] ❌ 自动修复未能让新版 daemon 提供服务（$( [ -n "$assist_code" ] && echo "仍返回 ${#assist_code} 位码" || echo "发现端点无响应" )）。"
    echo "[install]    请把以下几条输出发给支持人员："
    echo "[install]    1. zcode status"
    echo "[install]    2. cat ~/.zcode-install-serve.out"
    echo "[install]    3. ps auxww | grep -E 'server-cli.js|server-core.js' | grep -v grep"
    echo "[install]    4. command -v zcode && ls -l \$(command -v zcode)"
    exit 1
  fi
else
  echo "[install] --no-start: 仅安装。稍后运行 zcode serve 启动。"
fi
