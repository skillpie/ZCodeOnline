# 打包桌面端 Windows 版（ZCodeOnline Preview 身份，生产后端）并静默安装到本机。
#
# 用法（PowerShell，需在仓库根执行）：
#   .\install_desktop.ps1                # 构建 + 安装
#   .\install_desktop.ps1 -SkipBuild     # 跳过构建，使用 dist 里现有的 NSIS 安装包
#
# 前提：
# - 仅支持在 Windows 本机构建并安装（Node/pnpm 与打包工具链就绪）；
#   electron-builder 的 win 目标是 NSIS 单安装包（ZCodeOnline-<版本>-win-x64.exe）。
# - 运行会退出正在运行的 ZCodeOnline；未签名包可能触发 SmartScreen（"更多信息" -> "仍要运行"）。
# - 正式版 ZCode 不受影响（Preview 身份可与正式版并排）。
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir = Join-Path $ScriptDir "packages\desktop\dist"
$LogDir = Join-Path $env:USERPROFILE ".zcode\logs"
$LogFile = Join-Path $LogDir "desktop-install.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($Message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

if (-not $SkipBuild) {
  Write-Log "构建桌面端（ZCodeOnline Preview，win-x64，NSIS）..."
  $env:ZCODE_PREVIEW_IDENTITY = "1"
  Push-Location $ScriptDir
  try {
    # 构建输出全量进日志；退出码非 0 直接终止，禁止带旧包继续安装。
    pnpm bundle:desktop -- --os win --arch x64 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) {
      Write-Log "构建失败，终止（未改动已安装应用）"
      exit 1
    }
  }
  finally {
    Pop-Location
  }
}

$Installer = Get-ChildItem -Path $DistDir -Filter "ZCodeOnline-*-win-x64.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Installer) {
  Write-Log "未找到 NSIS 安装包（$DistDir\ZCodeOnline-*-win-x64.exe），终止"
  exit 1
}
Write-Log "使用产物: $($Installer.FullName)"

Write-Log "退出正在运行的 ZCodeOnline ..."
Get-Process -Name "ZCodeOnline" -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.CloseMainWindow() }
Start-Sleep -Seconds 3
Get-Process -Name "ZCodeOnline" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Log "静默安装（NSIS /S）..."
$proc = Start-Process -FilePath $Installer.FullName -ArgumentList "/S" -PassThru -Wait
if ($proc.ExitCode -ne 0) {
  Write-Log "安装程序退出码 $($proc.ExitCode)，请人工确认安装结果"
  exit 1
}

Write-Log "完成：ZCodeOnline 已静默安装（默认 %LOCALAPPDATA%\Programs\ZCodeOnline），可从开始菜单启动"
