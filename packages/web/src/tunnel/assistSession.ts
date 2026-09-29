// 浏览器侧远程协助码会话（specs/web-tunnel.md §5.9）。
// 授权模型是"码即凭证"：16 位码长期有效，浏览器把它存 localStorage（后到优先——
// 每次打开带码链接都覆盖旧值，存储读写收口在 @zcode/ui/assist-machine-store），
// 地址栏不保留码本身，防截图/历史记录泄露。兑换的传输实现在 @zcode/client
// （Web 与桌面共用）；本模块只保留 Web 专属部分：同源兑换端点装配与宿主回环
// 端点的码读取/轮换。
import {
  TUNNEL_CONSTANTS,
  TUNNEL_DISCOVERY_PORT,
  assistCodeResponseSchema,
  type TunnelAssistCode,
} from "@zcode/shared";
import { redeemAssistCodeViaEndpoint } from "@zcode/client";
import type { AssistRedeemResult } from "@zcode/client";
import { saveStoredAssistCode } from "@zcode/ui/assist-machine-store";

export { AssistRedeemError } from "@zcode/client";

// web 包内使用的存储函数经此统一出口（弹窗等 ui 侧直接用 @/assistMachineStore.js）。
export {
  clearStoredAssistCode,
  loadStoredAssistCode,
  saveStoredAssistCode,
  upsertAssistMachine,
} from "@zcode/ui/assist-machine-store";

/** Web 端兑换走同源相对路径（生产页与 relay 同域；dev 由 Vite 代理）。 */
const ASSIST_CONNECT_ENDPOINT = "/relay/api/v1/assist/connect";

/** 用远程码向 relay 兑换一次性连接票据与端到端 PSK（错误语义见 @zcode/client）。 */
export async function redeemAssistCode(code: string): Promise<AssistRedeemResult> {
  return redeemAssistCodeViaEndpoint(code, ASSIST_CONNECT_ENDPOINT);
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

const zh = (): boolean => /^zh\b/i.test(navigator.language);
const t = (zhText: string, enText: string) => (zh() ? zhText : enText);
