// 门禁安装引导的平台分流（specs/web-tunnel.md §5.7）：平台 → 一键安装命令的唯一映射。
// 纯模块便于测试；组件只消费结果，不在 JSX 里做平台分支。
// 命令与 deploy/DEPLOY.md §终端用户安装、install-zcode-server.* 脚本头注释保持同步。

export type TunnelInstallPlatform = "windows" | "posix";

/** Agent 代装指引的公开入口（nginx 别名；relay 内部路由为 /api/install/agent，不对外）。 */
export const AGENT_INSTALL_URL = "https://zcode.skillpie.cn/agent/install";

const POSIX_INSTALL_COMMAND = "curl -fsSL https://zcode.skillpie.cn/install.sh | sh";
const WINDOWS_POWERSHELL_INSTALL_COMMAND = "irm https://zcode.skillpie.cn/install.ps1 | iex";
const WINDOWS_CMD_INSTALL_COMMAND =
  "curl -fsSL https://zcode.skillpie.cn/install.cmd -o install.cmd && install.cmd";

export interface TunnelInstallCommand {
  /** 命令的目标 shell；POSIX 单命令时不标注（null）。 */
  shell: "PowerShell" | "CMD" | null;
  command: string;
}

/** 按 UA 判定平台：Windows 走 PowerShell/CMD 一键脚本，其余（含 UA 未知）沿用 POSIX shell。 */
export function detectTunnelInstallPlatform(userAgent: string): TunnelInstallPlatform {
  return /windows/i.test(userAgent) ? "windows" : "posix";
}

export function tunnelInstallCommands(platform: TunnelInstallPlatform): TunnelInstallCommand[] {
  if (platform === "windows") {
    return [
      { shell: "PowerShell", command: WINDOWS_POWERSHELL_INSTALL_COMMAND },
      { shell: "CMD", command: WINDOWS_CMD_INSTALL_COMMAND },
    ];
  }
  return [{ shell: null, command: POSIX_INSTALL_COMMAND }];
}
