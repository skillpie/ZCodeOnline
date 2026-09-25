# ZCode Server 一键安装 —— Windows CMD 兜底（无 PowerShell 执行策略限制）。
# 下载 PowerShell 安装脚本后以其执行；等价于 irm ... | iex 的显式形式。
# 用法：
#   curl -fsSL https://zcode.skillpie.cn/install.cmd -o install.cmd && install.cmd
# 可选参数会透传给 install.ps1（如 --workspace）：
#   install.cmd --workspace C:\code\my-project
@echo off
setlocal
set "SCRIPT=%TEMP%\zcode-install.ps1"
curl -fsSL https://zcode.skillpie.cn/install.ps1 -o "%SCRIPT%" || (echo [install] ERROR: download failed & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %errorlevel%
