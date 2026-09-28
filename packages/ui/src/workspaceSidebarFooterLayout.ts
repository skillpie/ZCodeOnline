/**
 * WorkspaceSidebarFooter Bot Channel 入口可见性裁决。
 *
 * 背景（bugfix）：Bot Channel 远程控制入口此前被 `isDesktop` 门控，Web 端
 * （Web + Server 与隧道两种宿主）完全看不到入口。而 Bot 运行时是宿主侧 Node
 * 服务：桌面 Host、zcode-server-cli 与 packages/server 都注册 IBotsService 并经
 * `/ws` 暴露，浏览器经 RemoteServiceAccess 的 botsService 代理即可读写配置；
 * 微信/飞书/Lark/Telegram 四个渠道全部走出站轮询或 WebSocket，不需要桌面能力。
 * 现统一为：只要有已解析的 workspacePath 即渲染，桌面行为不变。
 */
export function shouldRenderBotChannelTrigger(input: { workspacePath?: string }): boolean {
  return Boolean(input.workspacePath?.trim());
}
