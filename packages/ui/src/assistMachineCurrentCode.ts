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

/**
 * 「本机」语义门控（specs/web-tunnel.md §5.9「宿主不在本机时无本机条目与刷新能力」）：
 * 仅权威回环发现（expiresAt 非 null，浏览器与宿主同机）返回本机码。移动端 127.0.0.1
 * 永不可达、当不了宿主机，getRemoteAssistCode 回退返回的存储码可能是正在远控的其他
 * 机器——返回 null，本机徽标、刷新、置顶、添加查重与桌面本地模式当前判定一律不生效。
 */
export function resolveLocalAssistCode(code: string | null, authoritative: boolean): string | null {
  return authoritative ? code : null;
}
