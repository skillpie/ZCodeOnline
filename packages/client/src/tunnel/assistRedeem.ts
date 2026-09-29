// 远程码兑换（specs/web-tunnel.md §5.9「码即凭证」）：16 位码向 relay 换一次性
// 连接票据 + 端到端 PSK（校验不消费，码可反复使用）。HTTP 端点由调用方注入：
// Web 传同源相对路径（/relay/api/v1/assist/connect），桌面走 main 进程代理通道
// （relay CORS 白名单不含桌面 origin）。存储读写收口在 @zcode/ui/assist-machine-store。
import { assistConnectResultSchema, revealAssistPsk } from "@zcode/shared";
import type { RedeemAssistCodeResult } from "@zcode/shared";

export interface AssistRedeemResult {
  hostId: string;
  connectToken: string;
  psk: string;
}

type AssistRedeemErrorKind = "invalid" | "rateLimited" | "network" | "generic";

export class AssistRedeemError extends Error {
  constructor(
    message: string,
    readonly kind: AssistRedeemErrorKind,
  ) {
    super(message);
    this.name = "AssistRedeemError";
  }
}

const zh = (): boolean => /^zh\b/i.test(navigator.language);
const t = (zhText: string, enText: string) => (zh() ? zhText : enText);

/**
 * 用远程码向 relay 兑换一次性连接票据与端到端 PSK。
 * kind=invalid 表示码已被轮换/不存在——调用方据此清存储并回退其他连接方式，不锁死客户端。
 */
export async function redeemAssistCodeViaEndpoint(
  code: string,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AssistRedeemResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new AssistRedeemError(
      t("无法连接 relay 服务，请检查网络后重试。", "Cannot reach the relay; check your network."),
      "network",
    );
  }
  if (response.status === 401) {
    throw new AssistRedeemError(
      t("远程码无效或已被刷新。", "The assist code is invalid or has been rotated."),
      "invalid",
    );
  }
  if (response.status === 429) {
    throw new AssistRedeemError(
      t("尝试过于频繁，请稍后再试。", "Too many attempts. Try again shortly."),
      "rateLimited",
    );
  }
  if (!response.ok) {
    throw new AssistRedeemError(
      t("兑换远程码失败，请稍后重试。", "Failed to redeem the assist code."),
      "generic",
    );
  }
  const parsed = assistConnectResultSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AssistRedeemError(
      t("兑换远程码失败，请稍后重试。", "Failed to redeem the assist code."),
      "generic",
    );
  }
  return {
    hostId: parsed.data.hostId,
    connectToken: parsed.data.connectToken,
    psk: await revealAssistPsk(parsed.data.maskedPsk, code),
  };
}

/**
 * 桌面 IPC 结构化应答（shared RedeemAssistCodeResult）→ 与端点路径同一套错误语义。
 * 桌面 renderer 的兑换经 main 进程代理（CORS），错误归类跨进程传输，这里还原为异常。
 */
export function assertRedeemResult(result: RedeemAssistCodeResult): AssistRedeemResult {
  if (result.ok) {
    return { hostId: result.hostId, connectToken: result.connectToken, psk: result.psk };
  }
  throw new AssistRedeemError(result.message, result.kind);
}
