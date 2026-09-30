# ZCode Server 一键安装 —— Windows PowerShell（specs/web-tunnel.md §5.7）
# 用法（CMD）：
#   curl -fsSL https://zcode.skillpie.cn/install.ps1 -o install.ps1 && powershell -ExecutionPolicy Bypass -File install.ps1
# 或（PowerShell）：
#   irm https://zcode.skillpie.cn/install.ps1 | iex
# 参数（-File 方式）：-InstallDir <dir> -Workspace <dir> -Start
param(
    [string]$Archive = "",
    [string]$BaseUrl = "https://zcode.skillpie.cn/dl",
    [string]$InstallDir = "$env:ProgramData\zcode-server",
    [string]$Workspace = "",
    [switch]$Start
)

$ErrorActionPreference = "Stop"

# ---- 平台/架构探测（stage target：win32-x64） ----
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
if ($arch -ne "x64") {
    Write-Host "[install] ERROR: only win32-x64 builds are published" -ForegroundColor Red
    exit 1
}
$target = "win32-x64"

# ---- 归档获取 ----
$tmp = Join-Path $env:TEMP ("zcode-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

function Download-Release([string]$Url, [string]$Destination) {
    # curl.exe（Windows 10 1803+ 内置，与下方 tar.exe 同一代基线）带原生进度条；
    # 注意 PowerShell 5.1 里裸 `curl` 是 Invoke-WebRequest 的别名，必须写 curl.exe。
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -fS --progress-bar -L -o $Destination $Url
        if ($LASTEXITCODE -ne 0) { throw "curl download failed: $Url" }
        return
    }
    # 老系统回退 Invoke-WebRequest：其默认进度条会显著拖慢大文件下载，这里关闭进度换取速度。
    Write-Host "[install] curl.exe not found, falling back to Invoke-WebRequest (no progress)"
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

if ($Archive -eq "") {
    $Archive = Join-Path $tmp "zcode-server-$target.tar.gz"
    Write-Host "[install] downloading release for $target from $BaseUrl (~70-90 MB)"
    try {
        Download-Release "$BaseUrl/zcode-server-$target.tar.gz" $Archive
    } catch {
        Write-Host "[install] ERROR: release download failed. Is it published on $BaseUrl ?" -ForegroundColor Red
        exit 1
    }
}

# tar.exe 自 Windows 10 1803 起内置。
# 整目录替换而非原地解压：归档内层为 zcode-server-<target>/，原地解压到已有
# 安装目录时顶层 bin\zcode.cmd 已存在、嵌套子目录不会被拍平，旧文件继续服役——
# 这是"重装永远不生效"的根因（与 install-zcode-server.sh 同源 bug）。先在临时
# 目录拍平，再整体替换，并保留 env 文件。
Write-Host "[install] extracting to $InstallDir"
$extract = Join-Path $tmp "extract"
New-Item -ItemType Directory -Path $extract -Force | Out-Null
tar -xzf $Archive -C $extract

$extractLauncher = Join-Path $extract "bin\zcode.cmd"
if (-not (Test-Path $extractLauncher)) {
    $inner = Get-ChildItem -Path $extract -Directory -Filter "zcode-server-*" | Select-Object -First 1
    if ($inner) {
        Get-ChildItem -Path $inner.FullName | Move-Item -Destination $extract -Force
        Remove-Item $inner.FullName -Force
    }
}
if (-not (Test-Path (Join-Path $extract "bin\zcode.cmd"))) {
    Write-Host "[install] ERROR: bin/zcode.cmd not found after extraction" -ForegroundColor Red
    exit 1
}

$envBackup = $null
$envFile = Join-Path $InstallDir "env"
if (Test-Path $envFile) { $envBackup = Copy-Item $envFile (Join-Path $tmp "env.bak") -PassThru }
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Move-Item -Path $extract -Destination $InstallDir
if ($envBackup) { Copy-Item $envBackup.FullName (Join-Path $InstallDir "env") -Force }

# ---- 受管安装标记（specs/web-tunnel.md 更新器 M4）：daemon 据此启用自动更新调度器 ----
$dataRoot = Join-Path $env:USERPROFILE ".zcode\server"
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$marker = @{ product = "zcode-server"; managed = $true; installedAt = [int][double]::Parse((Get-Date -UFormat %s)) }
Set-Content -Path (Join-Path $dataRoot "managed-install.json") -Value ($marker | ConvertTo-Json -Compress)

# ---- 工作区环境：写入安装目录 env 文件（serve/systemd 同机自用场景） ----
if ($Workspace -ne "") {
    Set-Content -Path (Join-Path $InstallDir "env") -Value "ZCODE_SERVER_WORKSPACE=$Workspace"
    Write-Host "[install] workspace: $Workspace (edit $InstallDir\env to change)"
}

# ---- PATH（用户级，永久） ----
$binDir = Join-Path $InstallDir "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    Write-Host "[install] added $binDir to user PATH（新开终端生效）"
}

Write-Host "[install] done."

# ---- 旧 daemon 检查（specs/web-tunnel.md §5.9）：新版 core 的发现端点只可能返回 8 位码，
# 16 位 = 旧版 daemon 仍在运行。serve 会尝试替换它；装完若仍 16 位，zcode stop 后重跑本脚本。
try {
    $assist = Invoke-RestMethod -Uri "http://127.0.0.1:4950/tunnel/assist" `
        -Headers @{ Origin = "https://zcode.skillpie.cn" } -TimeoutSec 5
    if ($assist.code -and $assist.code.Length -ne 8) {
        Write-Warning "[install] 发现端点返回 $($assist.code.Length) 位码：旧版 daemon 正在运行，serve 将尝试替换；装完仍是 16 位时请 zcode stop 后重跑本脚本。"
    }
} catch { }

if ($Start) {
    Write-Host "[install] starting zcode serve..."
    & (Join-Path $InstallDir "bin\zcode.cmd") serve
} else {
    Write-Host "next: zcode serve && zcode tunnel-pair (model login is optional - use the sign-in entry at the bottom-left of the web UI)" 
}
