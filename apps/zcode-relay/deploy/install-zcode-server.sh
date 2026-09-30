#!/bin/sh
# ZCode Server 一键安装（specs/web-tunnel.md §5.7）—— macOS / Linux。
# （Windows 用 install.ps1 / install.cmd，见 DEPLOY.md）
# 标准形态（平台自动探测 + 从本站下载）：
#   curl -fsSL https://zcode.skillpie.cn/install.sh | sh
# 强制卸载重装（旧 daemon 被系统服务反复复活时）：
#   curl -fsSL https://zcode.skillpie.cn/install.sh | sh -s -- --force-clean
# 等价显式形式：
#   install-zcode-server.sh [--base-url <url>] [--install-dir <dir>] [--workspace <dir>] [--start]
# 离线/自托管归档：
#   install-zcode-server.sh --archive <file.tar.gz> [同上]
#
# 默认行为：安装 → 注册常驻服务（开机自启）→ 立即启动，并打印远程控制链接。
# 重复安装命中本地缓存（~/.zcode/downloads，按 catalog.json 的 sha256 对账）不重下载。
# --no-start 仅安装不启动；模型账号登录可在浏览器界面左下角完成（可选）。
# 首次配对/日常使用：zcode status 查看；浏览器打开打印的 https://zcode.skillpie.cn/<码>。

set -e

DEFAULT_BASE_URL="https://zcode.skillpie.cn/dl"
BASE_URL=""
ARCHIVE=""
INSTALL_DIR="/opt/zcode-server"
WORKSPACE=""
START=true
FORCE_CLEAN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --start) START=true; shift ;;
    --no-start) START=false; shift ;;
    --force-clean) FORCE_CLEAN=true; shift ;;
    --help|-h)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
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

# ---- 卸载/自愈共用：注销服务 + 终止进程 ----
# daemon 注册的服务是"异常退出自动复活"（launchd KeepAlive=SuccessfulExit:false /
# systemd Restart=on-failure），不先注销，pkill 杀掉的旧 daemon 会被立即拉回——
# 这是"重装换不掉旧 daemon"的根因。标签精确匹配 com.zhipu.zcode.server 前缀，
# 不动桌面 App 等其它 zcode 服务。
deregister_services() {
  if command -v launchctl >/dev/null 2>&1; then
    for label in $(launchctl list 2>/dev/null | awk '$3 ~ /^com\.zhipu\.zcode\.server/ {print $3}'); do
      launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    done
    rm -f "$HOME/Library/LaunchAgents/"com.zhipu.zcode.server.* 2>/dev/null || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now 'com.zhipu.zcode.server.*' >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/"com.zhipu.zcode.server.* 2>/dev/null || true
    rm -f "/etc/systemd/system/"com.zhipu.zcode.server.* 2>/dev/null || true
  fi
}

# 先 supervisor 后 core，双扫收敛：supervisor 存活会把被杀的 core 崩溃重启拉回，
# 两个进程组都要终止；命令行特征与桌面端 zcode-cli 进程不相交。特征杀完后按
# 4950 端口占用者 PID 再兜底击杀——发现端点是固定端口，占用者必是 daemon，
# 按 PID 杀绕开"命令行特征不匹配导致 pkill 杀不掉"的一切变体。
kill_daemon_processes() {
  pkill -f "server-cli.js" >/dev/null 2>&1 || true
  sleep 1
  pkill -f "server-core.js" >/dev/null 2>&1 || true
  sleep 1
  if command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -tiTCP:4950 -sTCP:LISTEN 2>/dev/null); do
      kill "$pid" >/dev/null 2>&1 || true
    done
    sleep 2
    for pid in $(lsof -tiTCP:4950 -sTCP:LISTEN 2>/dev/null); do
      kill -9 "$pid" >/dev/null 2>&1 || true
    done
    sleep 1
  fi
  pkill -f "server-cli.js" >/dev/null 2>&1 || true
  pkill -f "server-core.js" >/dev/null 2>&1 || true
  sleep 1
}

if [ -z "$BASE_URL" ]; then
  BASE_URL="$DEFAULT_BASE_URL"
fi

# ---- 安装目录：系统级用 /opt，无 root 时回退用户目录 ----
if [ ! -w "$(dirname "$INSTALL_DIR")" ] && [ "$(id -u)" != "0" ]; then
  INSTALL_DIR="$HOME/.zcode-server"
  echo "[install] no permission for default dir, using $INSTALL_DIR"
fi

# ---- 强制卸载重装：注销服务 + 杀进程 + 清数据根/旧安装/PATH 链接 ----
# ~/.zcode 下会话、登录凭据、技能均保留；机器身份重新生成（远程码会变）。
if [ "$FORCE_CLEAN" = true ]; then
  echo "[install] --force-clean：注销系统服务、终止 daemon 进程并清除旧安装…"
  deregister_services
  kill_daemon_processes
  rm -rf "$HOME/.zcode/server"
  for stale in /opt/zcode-server "$HOME/.zcode-server"; do
    if [ "$stale" != "$INSTALL_DIR" ]; then rm -rf "$stale" 2>/dev/null || true; fi
  done
  rm -f /usr/local/bin/zcode "$HOME/.local/bin/zcode" /opt/homebrew/bin/zcode 2>/dev/null || true
  echo "[install] 清理完成，开始全新安装。"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---- 下载（带本地缓存：catalog sha256 对账命中则跳过下载）----
# 缓存位于 ~/.zcode/downloads（--force-clean 不清除）。以 catalog.json 的
# archiveSha256 为准：命中跳过、不匹配重下并校验后入缓存；catalog 不可达或本机
# 无 sha256 工具时无法证明缓存即最新，回落为每次全量下载（与旧行为一致）。
CACHE_DIR="${CACHE_DIR:-$HOME/.zcode/downloads}"

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else echo ""
  fi
}

# 从 catalog.json 提取本 target 的 archiveSha256（条目内 target 行先于 archiveSha256 行）。
catalog_sha256() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -m 15 "$BASE_URL/catalog.json" 2>/dev/null
  else
    wget -qO- -T 15 "$BASE_URL/catalog.json" 2>/dev/null
  fi | awk -v target="$TARGET" '
    /"target":/ { inobj = ($0 ~ "\"" target "\"") }
    inobj && /"archiveSha256":/ { gsub(/.*"archiveSha256": *"|".*/, ""); print; exit }
  '
}

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$TMP/zcode-server-$TARGET.tar.gz"
  EXPECTED_SHA256=$(catalog_sha256)
  CACHE_FILE="$CACHE_DIR/zcode-server-$TARGET.tar.gz"
  if ! mkdir -p "$CACHE_DIR" 2>/dev/null; then CACHE_FILE=""; fi
  if [ -n "$CACHE_FILE" ] && [ -n "$EXPECTED_SHA256" ] && [ -f "$CACHE_FILE" ] \
    && [ "$(file_sha256 "$CACHE_FILE")" = "$EXPECTED_SHA256" ]; then
    cp "$CACHE_FILE" "$ARCHIVE"
    echo "[install] 使用本地缓存（sha256 与 catalog 一致，跳过下载）：$CACHE_FILE"
  else
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
    # 下载后按 catalog 校验（无 sha256 工具时跳过校验，保持旧行为），通过后写入缓存。
    ACTUAL_SHA256=$(file_sha256 "$ARCHIVE")
    if [ -n "$EXPECTED_SHA256" ] && [ -n "$ACTUAL_SHA256" ] \
      && [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
      echo "[install] ERROR: sha256 mismatch (expected $EXPECTED_SHA256, got $ACTUAL_SHA256)" >&2
      exit 1
    fi
    if [ -n "$CACHE_FILE" ] && [ -n "$ACTUAL_SHA256" ]; then
      cp "$ARCHIVE" "$CACHE_FILE"
    fi
  fi
fi

echo "[install] extracting to $INSTALL_DIR"
# 整目录替换而非原地解压：归档内层为 zcode-server-<target>/，原地解压到已有
# 安装目录时顶层 bin/zcode 已存在、嵌套子目录不会被拍平，旧文件继续服役——
# 这是"重装永远不生效"的根因。先在临时目录拍平，再整体替换，并保留 env 文件。
EXTRACT="$TMP/extract"
mkdir -p "$EXTRACT"
tar -xf "$ARCHIVE" -C "$EXTRACT"
if [ ! -x "$EXTRACT/bin/zcode" ] && ls "$EXTRACT"/zcode-server-*/bin/zcode >/dev/null 2>&1; then
  mv "$EXTRACT"/zcode-server-*/* "$EXTRACT"/ 2>/dev/null || true
  rmdir "$EXTRACT"/zcode-server-* 2>/dev/null || true
fi
if [ ! -x "$EXTRACT/bin/zcode" ]; then
  echo "[install] ERROR: bin/zcode not found after extraction" >&2
  exit 1
fi
if [ -f "$INSTALL_DIR/env" ]; then cp "$INSTALL_DIR/env" "$TMP/env.bak"; fi
rm -rf "$INSTALL_DIR"
mv "$EXTRACT" "$INSTALL_DIR"
if [ -f "$TMP/env.bak" ]; then cp "$TMP/env.bak" "$INSTALL_DIR/env"; fi

# ---- 受管安装标记（specs/web-tunnel.md 更新器 M4）：daemon 据此启用自动更新调度器 ----
# 写入 data root（~/.zcode/server，与 daemon 默认根一致）；标记损坏时 daemon 侧
# fail closed 不自更新，故保持最小 JSON。
mkdir -p "$HOME/.zcode/server" 2>/dev/null || true
printf '{"product":"zcode-server","managed":true,"installedAt":%s}\n' "$(date +%s)" \
  > "$HOME/.zcode/server/managed-install.json"

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
    echo "[install] 旧 daemon 疑被系统服务复活（KeepAlive/Restart=on-failure），注销服务并重置运行态…"
    deregister_services
    kill_daemon_processes
    rm -rf "$HOME/.zcode/server"
    for stale in /opt/zcode-server "$HOME/.zcode-server"; do
      if [ "$stale" != "$INSTALL_DIR" ]; then rm -rf "$stale" 2>/dev/null || true; fi
    done
    launch_daemon
    assist_code=$(query_assist_code)
  fi
  if [ -n "$assist_code" ] && [ "${#assist_code}" -eq 8 ]; then
    echo "[install] 自检通过：发现端点返回 8 位远程码。"
    echo "[install] 服务已注册为开机自启；电脑重启后会自动恢复，链接不变。"
  else
    # 失败时把启动日志与排障证据转移到持久位置（trap 会清理 $TMP），一份文件
    # 涵盖全部所需信息，用户只需发回该文件内容。
    cp "$TMP/serve.out" "$HOME/.zcode-install-serve.out" 2>/dev/null || true
    {
      echo "== zcode status =="
      "$INSTALL_DIR/bin/zcode" status 2>&1 || true
      echo "== serve.out（启动日志）=="
      cat "$HOME/.zcode-install-serve.out" 2>/dev/null || true
      echo "== daemon 进程 =="
      ps auxww 2>/dev/null | grep -E "server-cli.js|server-core.js" | grep -v grep || echo "(无)"
      echo "== 4950 端口占用者（决定性证据）=="
      if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:4950 -sTCP:LISTEN 2>/dev/null || echo "(无监听)"
        for pid in $(lsof -tiTCP:4950 -sTCP:LISTEN 2>/dev/null); do
          ps -o pid,user,lstart,command -p "$pid" 2>/dev/null || true
        done
      else
        echo "(lsof 不可用)"
      fi
      echo "== zcode 相关服务 =="
      if command -v launchctl >/dev/null 2>&1; then
        launchctl list 2>/dev/null | grep -i zcode || echo "(无)"
      fi
      command -v systemctl >/dev/null 2>&1 && systemctl --user list-units 2>/dev/null | grep -i zcode
      echo "== 发现端点现状 =="
      if command -v curl >/dev/null 2>&1; then
        curl -fsS -m 5 -H "Origin: https://zcode.skillpie.cn" \
          http://127.0.0.1:4950/tunnel/assist 2>&1 || true
      elif command -v wget >/dev/null 2>&1; then
        wget -qO- -T 5 --header "Origin: https://zcode.skillpie.cn" \
          http://127.0.0.1:4950/tunnel/assist 2>&1 || true
      fi
      echo ""
    } > "$HOME/.zcode-install-diagnose.txt" 2>&1
    echo "[install] ❌ 自动修复未能让新版 daemon 提供服务（$( [ -n "$assist_code" ] && echo "仍返回 ${#assist_code} 位码" || echo "发现端点无响应" )）。"
    echo "[install]    请把 ~/.zcode-install-diagnose.txt 的内容发给支持人员。"
    exit 1
  fi
else
  echo "[install] --no-start: 仅安装。稍后运行 zcode serve 启动。"
fi
