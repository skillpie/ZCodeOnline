# ZCode Server 一键安装 —— Windows PowerShell（specs/web-tunnel.md §5.7）
# 默认行为：安装 → 注册开机自启服务（计划任务 ONLOGON）→ 后台启动 daemon → 发现端点自检。
# 装完浏览器打开 https://zcode.skillpie.cn 即可使用（首次需在网页登录账号完成自动配对）。
# 用法（CMD）：
#   curl -fsSL https://zcode.skillpie.cn/install.ps1 -o install.ps1 && powershell -ExecutionPolicy Bypass -File install.ps1
# 或（PowerShell）：
#   irm https://zcode.skillpie.cn/install.ps1 | iex
# 参数（-File 方式）：-InstallDir <dir> -Workspace <dir>；-NoStart 仅安装不启动（之后手动 zcode serve）
param(
    [string]$Archive = "",
    [string]$BaseUrl = "https://zcode.skillpie.cn/dl",
    [string]$InstallDir = "$env:ProgramData\zcode-server",
    [string]$Workspace = "",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

# 发现端口/服务身份与 server-cli 约定一致（packages/shared/src/tunnel.ts、serviceManager.ts）。
$RelayOrigin = "https://zcode.skillpie.cn"
$DiscoveryPort = 4950
$DataTaskName = "com.zhipu.zcode.server"
$dataRoot = Join-Path $env:USERPROFILE ".zcode\server"

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

# ---- daemon 生命周期辅助：发现端点自检 + 残留进程清理 ----

# 自检以发现端点实测为准（specs/web-tunnel.md §5.9）：8 位 = 新版 daemon；
# 16 位 = 旧版 daemon 仍在跑；空 = 端点无响应（serve 未起来）。短暂重试以等待
# core ready 后异步生成并落盘的机器码。
function Get-AssistCode {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            $assist = Invoke-RestMethod -Uri "http://127.0.0.1:$DiscoveryPort/tunnel/assist" `
                -Headers @{ Origin = $RelayOrigin } -TimeoutSec 2
            if ($assist.code) { return [string]$assist.code }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return ""
}

# 只杀命令行指向本安装目录的 node.exe：supervisor（server-cli.js）先杀、
# core（server-core.js）后杀——反过来会被存活的 supervisor 崩溃重启拉回。
# 与桌面端及其它 zcode 进程不相交（它们的可执行文件不在安装目录下）。
# 最后按 4950 端口占用者 PID 兜底击杀：发现端点是固定端口，占用者必是 daemon，
# 绕开命令行特征不匹配导致杀不掉的一切变体（对齐 sh 版 kill_daemon_processes）。
function Stop-DaemonProcesses {
    $dirLower = $InstallDir.ToLower()
    foreach ($marker in @("server-cli.js", "server-core.js")) {
        $markerLower = $marker.ToLower()
        $targets = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.ToLower().Contains($dirLower) -and
                $_.CommandLine.ToLower().Contains($markerLower)
            }
        foreach ($proc in $targets) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
    $listeners = Get-NetTCPConnection -LocalPort $DiscoveryPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $listeners) {
        if ($procId -and $procId -ne $PID) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    if ($listeners) { Start-Sleep -Seconds 1 }
}

# 判定安装目录的 daemon 是否仍监听发现端点（stop 被拒绝/失败时的决定性证据）。
function Test-InstallDirDaemonListening {
    try {
        $listeners = Get-NetTCPConnection -LocalPort $DiscoveryPort -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $listeners) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.Path -and $proc.Path.ToLower().Contains($InstallDir.ToLower())) {
                return $true
            }
        }
    } catch { }
    return $false
}

function Write-ManagedInstallMarker {
    # 受管安装标记（specs/web-tunnel.md 更新器 M4）：daemon 据此启用自动更新调度器。
    # 自检阶梯清运行态会连带删掉它，删除后必须重写，否则自动更新静默失效。
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $marker = @{ product = "zcode-server"; managed = $true; installedAt = [int][double]::Parse((Get-Date -UFormat %s)) }
    Set-Content -Path (Join-Path $dataRoot "managed-install.json") -Value ($marker | ConvertTo-Json -Compress)
}

# ---- 停旧 daemon：Windows 运行中的 runtime\node.exe 被锁定，不停无法整目录替换 ----
# macOS 无强制文件锁，可先替换、由启动后的自检阶梯换进程；Windows 必须先停。
# 计划任务是 ONLOGON 触发（不像 launchd KeepAlive 立即复活），停掉后替换期间安全。
$oldLauncher = Join-Path $InstallDir "bin\zcode.cmd"
if (Test-Path $oldLauncher) {
    Write-Host "[install] stopping previous daemon before replacing files..."
    & $oldLauncher stop 2>$null | Out-Null
    Start-Sleep -Seconds 2
}
if (Test-InstallDirDaemonListening) {
    # stop 拒绝退出通常是 daemon 有进行中任务：强杀会丢任务，中止安装更安全
    # （与 install_cli.sh「运行中任务不重启」的产品规则一致）。此时未改动任何文件。
    Write-Host "[install] ERROR: 旧 daemon 未能停止（可能有进行中任务）。" -ForegroundColor Red
    Write-Host "[install]    请等任务结束后重跑本脚本，或手动执行 zcode stop 后重跑。本次未改动已安装应用。"
    exit 1
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

Write-ManagedInstallMarker

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

$Launcher = Join-Path $InstallDir "bin\zcode.cmd"
$ServeOut = Join-Path $tmp "serve.out"

# 注册计划任务并后台启动：serve --daemon 注册 ONLOGON 计划任务、启动 Supervisor 后
# CLI 等 ready 即返回（daemon 常驻）；输出直写终端并留档供失败诊断。
function Start-Daemon {
    Write-Host "[install] registering boot-persistent service and starting daemon..."
    & $Launcher serve --daemon 2>&1 | Tee-Object -FilePath $ServeOut
    Start-Sleep -Seconds 2
}

if ($NoStart) {
    Write-Host "[install] -NoStart: 仅安装。稍后运行 zcode serve 启动。"
    exit 0
}

# ---- 启动 + 自检修复阶梯（对齐 install-zcode-server.sh，以发现端点实测为准）----
Start-Daemon
$assistCode = Get-AssistCode
if ($assistCode -and $assistCode.Length -ne 8) {
    # 16 位等异常码只可能来自旧版 daemon（新版 core 返回前有 8 位服务端校验）。
    Write-Warning "[install] 旧版 daemon 未被替换（返回 $($assistCode.Length) 位码），优雅替换中…"
    & $Launcher stop 2>$null | Out-Null
    Start-Sleep -Seconds 2
    Start-Daemon
    $assistCode = Get-AssistCode
}
if ($assistCode -and $assistCode.Length -ne 8) {
    Write-Host "[install] 优雅停止后仍异常，强制结束残留 daemon 进程…"
    Stop-DaemonProcesses
    Start-Daemon
    $assistCode = Get-AssistCode
}
if ($assistCode -and $assistCode.Length -ne 8) {
    Write-Host "[install] 旧 daemon 疑被计划任务复活，注销任务并重置运行态…"
    Get-ScheduledTask -TaskName "$DataTaskName*" -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    Stop-DaemonProcesses
    # 运行态重建（~/.zcode 下会话/登录数据不受影响）；managed 标记被连带清除，需重写。
    Remove-Item $dataRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-ManagedInstallMarker
    Start-Daemon
    $assistCode = Get-AssistCode
}
if ($assistCode -and $assistCode.Length -eq 8) {
    Write-Host "[install] 自检通过：发现端点返回 8 位远程码。"
    Write-Host "[install] 服务已注册为开机自启；电脑重启后会自动恢复，链接不变。"
    Write-Host "[install] 浏览器打开 https://zcode.skillpie.cn 即可使用（首次需登录网页账号完成自动配对）。"
} else {
    # 失败时把启动日志与排障证据转移到持久位置（$tmp 会被系统清理），一份文件
    # 涵盖全部所需信息，用户只需发回该文件内容。
    $diagnosePath = Join-Path $env:USERPROFILE ".zcode-install-diagnose.txt"
    $statusText = ""
    try { $statusText = (& $Launcher status 2>&1 | Out-String) } catch { }
    & {
        "== zcode status =="
        $statusText
        "== serve.out（启动日志）=="
        Get-Content $ServeOut -ErrorAction SilentlyContinue
        "== daemon 进程（安装目录下 node.exe）=="
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($InstallDir.ToLower()) } |
            Format-List ProcessId, CommandLine | Out-String
        "== 4950 端口占用者（决定性证据）=="
        Get-NetTCPConnection -LocalPort $DiscoveryPort -ErrorAction SilentlyContinue |
            ForEach-Object {
                $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
                "pid=$($_.OwningProcess) path=$(if ($proc) { $proc.Path } else { '(未知)' })"
            } | Out-String
        "== zcode 计划任务 =="
        Get-ScheduledTask -TaskName "$DataTaskName*" -ErrorAction SilentlyContinue |
            Format-List TaskName, State | Out-String
        "== 发现端点现状 =="
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$DiscoveryPort/tunnel/assist" `
                -Headers @{ Origin = $RelayOrigin } -TimeoutSec 5 | ConvertTo-Json
        } catch { "(无响应: $($_.Exception.Message))" }
    } > $diagnosePath 2>&1
    $observed = if ($assistCode) { "仍返回 $($assistCode.Length) 位码" } else { "发现端点无响应" }
    Write-Host "[install] ❌ 自动修复未能让新版 daemon 提供服务（$observed）。" -ForegroundColor Red
    Write-Host "[install]    请把 $diagnosePath 的内容发给支持人员。"
    exit 1
}
