// 远程控制弹窗「当前机器」解析（specs/web-tunnel.md §5.9）：当前生效码是卡片选中
// 高亮的唯一事实。存储活动码（zcode-assist-code）优先；桌面本地模式没有活动码
// （未进隧道）时本机即当前机器——对应旧版「桌面本机行切换置灰」的语义。Web 无活动码时
// 不视任何条目为当前（门禁外状态，卡片全部可点）。
export function resolveCurrentAssistCode(
  activeCode: string | null,
  localCode: string | null,
  isDesktop: boolean,
): string | null {
  if (activeCode) return activeCode;
  return isDesktop ? localCode : null;
}
