// Agent 安装指引端点（参考 skillpie.cn/api/install/skillpie 的模式）：
// GET /api/install/agent 返回 text/plain 指引，用户把「URL + 一句话指令」粘给任意
// 智能体（ZCode/Claude/Codex…），智能体自行抓取本指引并按步骤完成安装。
// 指引内容与 deploy/install-zcode-server.sh、DEPLOY.md §终端用户安装 保持同步。


export const AGENT_INSTALL_GUIDE = `ZCode Server 安装指引（远程控制入口，specs/web-tunnel.md §5.7）

请按以下步骤在本机安装并启动 ZCode Server。安装完成后，用户即可在浏览器（https://zcode.skillpie.cn）远程控制这台电脑上的 ZCode。

**第一步：下载发行包**
使用可用的下载工具（curl / wget / PowerShell）下载对应平台的归档：
- macOS Apple Silicon: https://zcode.skillpie.cn/dl/zcode-server-darwin-arm64.tar.gz
- Linux x64: https://zcode.skillpie.cn/dl/zcode-server-linux-x64.tar.gz
- Windows x64: https://zcode.skillpie.cn/dl/zcode-server-win32-x64.tar.gz
归档自包含 Node 运行时与全部依赖，无需预装 Node。下载到临时目录备用。

**第二步：解压**
创建安装目录（系统级 /opt/zcode-server，无权限时用 ~/.zcode-server），将归档解压到该目录。
归档内层为 zcode-server-<target>/，将其中的全部内容移到安装目录根（确保存在 bin/zcode 或 bin/zcode.cmd）。

**第三步：加入 PATH**
- macOS/Linux：创建可执行启动脚本（内容：exec "<安装目录>/runtime/node" "<安装目录>/runtime/server-cli.js" "$@"），
  保存为 /usr/local/bin/zcode（或 ~/.local/bin/zcode）并 chmod +x。
- Windows：将 <安装目录>\\bin 加入用户 PATH。
- 优先用户级安装；遇到权限问题加 sudo（Linux/macOS）或以管理员运行（Windows）。

**第四步：写入默认工作区（可选）**
如果用户指定了项目目录，将 ZCODE_SERVER_WORKSPACE=<绝对路径> 写入 <安装目录>/env 文件。

**第五步：启动并确认**
运行 zcode serve（前台）或将 zcode serve 注册为系统服务（Linux systemd / Windows 服务 / macOS launchd）。
启动成功后会输出两行关键信息：
- "ZCode Server ready at 127.0.0.1:<端口>"
- "Remote access: https://zcode.skillpie.cn/<16位数字码>"
请把第二行的完整链接告知用户（这是这台机器的远程控制地址，长期有效）。

**第六步：确认**
运行 zcode status，确认 state 为 ready。遇到端口占用请检查 4950/8787；遇到下载失败请重试或换工具。

💡 提示：模型账号登录为可选步骤——用户可在浏览器界面左下角完成登录；如需 headless 预配置，运行 zcode login 并按提示在浏览器完成授权。

一键安装脚本（供 shell 用户直接使用，跳过上述步骤）：
- macOS/Linux: https://zcode.skillpie.cn/install.sh
- Windows PowerShell: https://zcode.skillpie.cn/install.ps1
- Windows CMD: https://zcode.skillpie.cn/install.cmd`;

import type { Hono } from "hono";

/** 注册 GET /api/install/agent：text/plain 安装指引（智能体抓取用）。 */
export function registerAgentInstallRoute(app: Hono): void {
  app.get("/api/install/agent", (context) => {
    context.header("Content-Type", "text/plain; charset=utf-8");
    return context.body(AGENT_INSTALL_GUIDE);
  });
}
