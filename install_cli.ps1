# 重建本机宿主 daemon（zcode-server-cli）并重启，让 zcode.skillpie.cn 的网页会话用上新 Agent 产物。
# Windows 版，与 install_cli.sh（macOS/Linux）语义一致。
#
# 用法（PowerShell，需在仓库根执行）：
#   .\install_cli.ps1                  # 构建 Agent 运行时 + 宿主 daemon（含依赖闭包），然后重启 daemon
#   .\install_cli.ps1 -SkipBuild       # 跳过构建，直接重启（复用现有 dist 产物）
#   .\install_cli.ps1 -NoRestart       # 只构建不重启（daemon 有运行中任务时先构建，稍后自行重启）
#
# 背景：deploy_web.sh 只上传静态 Web / relay / 发行包，不重建本机 daemon；
# 改动 apps/zcode-cli 或 packages/zcode-server-cli 后 daemon 不会自己重建，
# 网页会话会一直跑旧产物。daemon dev 态经 findUpward 定位
# apps/zcode-cli/packages/cli/dist/zcode.cjs，因此两个产物都要重建。
# 构建用 `--filter <pkg>...`（含 workspace 依赖闭包）：cli bundle 与 server-cli
# 引用各依赖包的 dist，只构建末端包会把中间包（如 @zcode/core）的旧 dist 打进
# 新 bundle——表现为「install 成功但 daemon 跑旧代码」。
#
# 注意：重启会中断 daemon 上运行中的网页会话任务（含 zcode status 里 runningTaskCount 未完成的）。
param(
  [switch]$SkipBuild,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# daemon 布局见 packages/zcode-server-cli/src/runtime/paths.ts（stableBinDir = <serverRoot>\bin，
# 默认 serverRoot = %USERPROFILE%\.zcode\server）与 serviceInstallation.ts（win32 启动器为 zcode.cmd）。
$ServerCli = Join-Path $env:USERPROFILE ".zcode\server\bin\zcode.cmd"

function Write-Step($Message) {
  Write-Host ""
  Write-Host "========== $Message ==========" -ForegroundColor Blue
}

Push-Location $ScriptDir
try {
  # $ErrorActionPreference = "Stop" 不接管原生命令的退出码，每次调用后必须显式检查
  # $LASTEXITCODE，禁止带旧产物继续执行（同 install_desktop.ps1 的构建检查策略）。
  if (-not $SkipBuild) {
    Write-Step "构建 Agent 运行时（@zcode/cli 及依赖闭包 → apps/zcode-cli/packages/cli/dist/zcode.cjs）"
    pnpm --filter @zcode/cli... run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Step "构建宿主 daemon（@zcode/server-cli 及依赖闭包 → packages/zcode-server-cli/dist/）"
    pnpm --filter @zcode/server-cli... run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  if (-not $NoRestart) {
    if (-not (Test-Path $ServerCli)) {
      Write-Host "未找到宿主 daemon 启动器 $ServerCli；本机可能尚未安装 zcode-server。" -ForegroundColor Red
      exit 1
    }
    Write-Step "重启宿主 daemon（运行中的网页会话任务会被中断）"
    & $ServerCli restart
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $ServerCli status
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
finally {
  Pop-Location
}
