// 浏览器侧隧道会话（specs/web-tunnel.md §3.3 配对时序 4-6）。
// 凭证与 PSK 暂存 localStorage（与现有 browserOAuthCredentialRepo 同级的取舍），
// M2 换内存 + 刷新凭证后迁移；expiresAt 带时钟余量校验，过期即要求重新配对。
import {
  TUNNEL_CONSTANTS,
  TUNNEL_DISCOVERY_PORT,
  parsePairingUrl,
  tunnelDiscoveryResponseSchema,
  type PairingPayload,
} from "@zcode/shared";

export interface TunnelSession {
  relayUrl: string;
  hostId: string;
  displayName: string;
  psk: string;
  sessionCredential: string;
  expiresAt: number;
}

const SESSION_STORAGE_KEY = "zcode-tunnel-session";
/** 凭证到期前 60s 即视为过期，给连接握手留余量。 */
const EXPIRY_MARGIN_MS = 60_000;

export class TunnelPairingError extends Error {
  /** auth = relay 要求账号登录（先登录再配对）；generic = 统一配对失败（防枚举，不区分原因）。 */
  constructor(
    message: string,
    readonly code: "auth" | "generic" = "generic",
  ) {
    super(message);
    this.name = "TunnelPairingError";
  }
}

/** relay 的 ws(s):// 地址转控制面 http(s):// 源。 */
export function relayHttpOrigin(relayUrl: string): string {
  if (relayUrl.startsWith("wss://")) return `https://${relayUrl.slice("wss://".length)}`;
  if (relayUrl.startsWith("ws://")) return `http://${relayUrl.slice("ws://".length)}`;
  return relayUrl;
}

export function loadTunnelSession(now = Date.now): TunnelSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as TunnelSession;
    if (
      typeof session.relayUrl !== "string" ||
      typeof session.hostId !== "string" ||
      typeof session.psk !== "string" ||
      typeof session.sessionCredential !== "string" ||
      typeof session.expiresAt !== "number"
    ) {
      return null;
    }
    if (session.expiresAt - EXPIRY_MARGIN_MS <= now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveTunnelSession(session: TunnelSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearTunnelSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

export interface LocalPairingDiscovery {
  pairingUrl: string;
  expiresAt: number;
  hostId: string;
  displayName: string;
}

/**
 * 本地配对发现（specs/web-tunnel.md §5.8）：向本机回环发现端点取新鲜配对会话。
 * 宿主未运行 / 不在本机 / 端口被占时快速失败返回 null（手机场景必然走此路径）。
 */
export async function discoverLocalPairing(
  fetchImpl: typeof fetch = fetch,
): Promise<LocalPairingDiscovery | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUNNEL_CONSTANTS.discoveryTimeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${TUNNEL_DISCOVERY_PORT}/tunnel/pairing`, {
      signal: controller.signal,
      // 同源策略下跨站 fetch localhost 需要宿主端 CORS 白名单；不带凭据。
      credentials: "omit",
    });
    if (!response.ok) return null;
    const parsed = tunnelDiscoveryResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface PairWithCodeOptions {
  pairingUrl: string;
  /** ZAI OAuth JWT；relay 参考实现解码校验 exp，M2 换验签。 */
  accessToken: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * 用配对码换取会话：解析二维码载荷 → relay /api/v1/pair → 持久化会话。
 * 失败一律抛 TunnelPairingError，消息已按用户可读文案归类（登录/配对码无效/网络）。
 */
export async function pairWithCode(options: PairWithCodeOptions): Promise<TunnelSession> {
  const now = options.now ?? Date.now;
  const payload: PairingPayload | null = parsePairingUrl(options.pairingUrl.trim());
  if (!payload) {
    throw new TunnelPairingError("配对码无效：请粘贴宿主机上展示的完整 zcode-tunnel:// 链接");
  }
  if (payload.expiresAt <= now()) {
    throw new TunnelPairingError("配对码已过期：请在宿主机上重新生成");
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${relayHttpOrigin(payload.relayUrl)}/api/v1/pair`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        },
        body: JSON.stringify({ hostId: payload.hostId, pairingToken: payload.pairingToken }),
      },
    );
  } catch {
    throw new TunnelPairingError("无法连接 relay 服务，请检查网络后重试");
  }
  // relay 按 spec §3.5 对配对 token 过期/重放返回统一错误码（防枚举）；
  // 仅"未携带有效账号凭证"返回独立的 unauthorized（此时配对 token 尚未被消费，无枚举泄露），
  // 据此引导用户先登录，而不是混入"配对码无效"的文案。
  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "unauthorized") {
      throw new TunnelPairingError("请先登录 ZCode 账号，再使用配对码连接", "auth");
    }
    throw new TunnelPairingError("配对码无效或已过期：请在宿主机上重新生成");
  }
  if (response.status === 400 || response.status === 404) {
    throw new TunnelPairingError(
      "配对码无效或已过期；若尚未登录 ZCode 账号，请先登录后重新粘贴配对码",
    );
  }
  if (!response.ok) {
    throw new TunnelPairingError(`配对失败（${String(response.status)}）：请稍后重试`);
  }
  const body = (await response.json()) as {
    sessionCredential?: unknown;
    expiresAt?: unknown;
    hostDisplayName?: unknown;
  };
  if (
    typeof body.sessionCredential !== "string" ||
    typeof body.expiresAt !== "number" ||
    typeof body.hostDisplayName !== "string"
  ) {
    throw new TunnelPairingError("relay 返回了无法识别的配对结果");
  }
  const session: TunnelSession = {
    relayUrl: payload.relayUrl,
    hostId: payload.hostId,
    displayName: body.hostDisplayName,
    psk: payload.psk,
    sessionCredential: body.sessionCredential,
    expiresAt: body.expiresAt,
  };
  saveTunnelSession(session);
  return session;
}
