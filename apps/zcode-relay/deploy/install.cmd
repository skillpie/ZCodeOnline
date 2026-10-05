@echo off
rem ZCode Server 一键安装 —— Windows CMD 兜底（无 PowerShell 执行策略限制）。
rem 下载 PowerShell 安装脚本后以其执行；等价于 irm ... | iex 的显式形式。
rem 默认行为与 install.ps1 一致：装完注册开机自启服务并后台启动，
rem 浏览器打开 https://zcode.skillpie.cn 即可使用（首次需登录网页账号完成自动配对）。
rem 用法：
rem   curl -fsSL https://zcode.skillpie.cn/install.cmd -o install.cmd && install.cmd
rem 可选参数会透传给 install.ps1（如 --workspace）：
rem   install.cmd --workspace C:\code\my-project
setlocal
set "SCRIPT=%TEMP%\zcode-install.ps1"
curl -fsSL https://zcode.skillpie.cn/install.ps1 -o "%SCRIPT%" || (echo [install] ERROR: download failed & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %errorlevel%
