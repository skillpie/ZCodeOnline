// 浏览器侧远程协助码会话（specs/web-tunnel.md §5.9）。
// 授权模型是"码即凭证"：16 位码长期有效，浏览器把它存 localStorage（后到优先——
// 每次打开带码链接都覆盖旧值），地址栏不再保留码本身，防截图/历史记录泄露。
// 存储与兑换的唯一读写路径都收口在本模块，TunnelAppRoot / main 入口只经这里的函数访问。
import {
  TUNNEL_CONSTANTS,
  TUNNEL_DISCOVERY_PORT,
  assistCodeResponseSchema,
  normalizeAssistCode,
  revealAssistPsk,
  type TunnelAssistCode,
} from "@zcode/shared";

const ASSIST_CODE_STORAGE_KEY = "zcode-assist-code";

export function loadStoredAssistCode(): string | null {
  try {
    return normalizeAssistCode(localStorage.getItem(ASSIST_CODE_STORAGE_KEY) ?? "");
  } catch {
    return null;
  }
}

/** 后到优先：多次使用不同远程码链接时，最后一次传入的码覆盖之前的。 */
export function saveStoredAssistCode(code: string): void {
  const normalized = normalizeAssistCode(code);
  if (!normalized) return;
  localStorage.setItem(ASSIST_CODE_STORAGE_KEY, normalized);
}

export function clearStoredAssistCode(): void {
  localStorage.removeItem(ASSIST_CODE_STORAGE_KEY);
}

interface AssistRedeemResult {
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
 * 用远程码向 relay 兑换一次性连接票据与端到端 PSK（校验不消费，码可反复使用）。
 * kind=invalid 表示码已被轮换/不存在——调用方据此清存储并回退其他连接方式，不锁死浏览器。
 */
export async function redeemAssistCode(code: string): Promise<AssistRedeemResult> {
  let response: Response;
  try {
    response = await fetch("/relay/api/v1/assist/connect", {
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
  const body = (await response.json()) as {
    hostId: string;
    connectToken: string;
    maskedPsk: string;
  };
  return {
    hostId: body.hostId,
    connectToken: body.connectToken,
    psk: await revealAssistPsk(body.maskedPsk, code),
  };
}

/**
 * 宿主侧当前远程码（specs/web-tunnel.md §5.9）：回环发现端点 GET /tunnel/assist。
 * 仅当浏览器与宿主同机可达；不可达时由调用方回退本地存储码展示。
 */
export async function fetchAssistCodeViaDiscovery(
  fetchImpl: typeof fetch = fetch,
): Promise<TunnelAssistCode> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUNNEL_CONSTANTS.discoveryTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${TUNNEL_DISCOVERY_PORT}/tunnel/assist`, {
      signal: controller.signal,
      // 同源策略下跨站 fetch localhost 需要宿主端 CORS 白名单；不带凭据。
      credentials: "omit",
    });
  } catch {
    throw new Error(
      t(
        "无法访问本机隧道服务：请在被控电脑上打开 ZCode Online。",
        "Local tunnel service unreachable: open ZCode Online on the controlled machine.",
      ),
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      t("远程码不可用，请稍后重试。", "The assist code is unavailable. Try again shortly."),
    );
  }
  const parsed = assistCodeResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      t("远程码不可用，请稍后重试。", "The assist code is unavailable. Try again shortly."),
    );
  }
  return parsed.data;
}

/**
 * 宿主侧刷新入口（specs/web-tunnel.md §5.9）：回环发现端点 POST /tunnel/assist/refresh。
 * 仅当浏览器与宿主同机可达；成功后把新码写回本地存储，旧链接即刻失效。
 */
export async function refreshAssistCodeViaDiscovery(
  fetchImpl: typeof fetch = fetch,
): Promise<TunnelAssistCode> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUNNEL_CONSTANTS.discoveryTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${TUNNEL_DISCOVERY_PORT}/tunnel/assist/refresh`, {
      method: "POST",
      signal: controller.signal,
      // 同源策略下跨站 fetch localhost 需要宿主端 CORS 白名单；不带凭据。
      credentials: "omit",
    });
  } catch {
    throw new Error(
      t(
        "无法访问本机隧道服务：请在被控电脑上打开 ZCode Online 后重试。",
        "Local tunnel service unreachable: open ZCode Online on the controlled machine and retry.",
      ),
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      t("刷新远程码失败，请稍后重试。", "Failed to refresh the assist code. Try again shortly."),
    );
  }
  const parsed = assistCodeResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      t("刷新远程码失败，请稍后重试。", "Failed to refresh the assist code. Try again shortly."),
    );
  }
  saveStoredAssistCode(parsed.data.code);
  return parsed.data;
}
