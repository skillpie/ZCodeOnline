// ZCode Web 隧道契约（specs/web-tunnel.md M1 数据面）。
// 本包纪律：只放 schema 类型 + 纯函数，禁止任何运行时/IO/传输逻辑。
// relay 只做鉴权、配对、心跳、转发；会话权威状态始终在本机宿主侧。
import { z } from "zod";

/** 隧道 wire 协议版本；握手双方携带，不一致直接拒绝（M3 再补能力探测式降级）。 */
export const TUNNEL_PROTOCOL_VERSION = 1 as const;

/** 隧道限额与节奏常量（初始值，实测调参）。 */
export const TUNNEL_CONSTANTS = {
  /** 配对码一次性、短 TTL： shoulder-surf 窗口压到最低。 */
  pairingTokenTtlMs: 120_000,
  /** M1 会话凭证长 TTL + 可吊销；M2 换短期 access + refresh 双凭证。 */
  sessionCredentialTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** 一次性连接票据 TTL：换掉 URL 里的长期凭证，防 access log 泄漏。 */
  connectTokenTtlMs: 60_000,
  /** 宿主控制通道心跳：低于即视为断开，relay 摘除路由。 */
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  /** 宿主出站重连：指数退避 + 抖动（惊群削峰参数化留 M4）。 */
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  /** 管道内单帧业务密文上限（对齐 v4 maxFrameBytes 量级）。 */
  maxFrameBytes: 1024 * 1024,
  /** 随机 secret 字节数（配对 token / PSK / 凭证）。 */
  secretBytes: 32,
} as const;

// ============================================================================
// 配对载荷（二维码 / 短码的编解码内容）
// ============================================================================

export const pairingPayloadSchema = z
  .object({
    /** relay 控制面 + 数据面同源 base URL，如 wss://relay.example.com。 */
    relayUrl: z.string().url(),
    hostId: z.string().trim().min(1).max(128),
    /** 一次性配对 token，明文只出现在二维码；relay 只存 SHA-256。 */
    pairingToken: z.string().min(32).max(128),
    /** 端到端预共享密钥（base64url，32 字节）：只进二维码，relay 永远拿不到。 */
    psk: z.string().min(43).max(128),
    /** 配对码过期时刻（Unix ms，CLI 时钟）。 */
    expiresAt: z.number().int().positive(),
    /** 宿主展示名（设备名/主机名），浏览器设备列表用。 */
    displayName: z.string().trim().min(1).max(128),
  })
  .strict();
export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

const PAIRING_URL_PREFIX = "zcode-tunnel://pair?";

/** 编码为二维码字符串：query 参数逐项 base64url，避免特殊字符撑爆二维码容量。 */
export function buildPairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams({
    v: String(TUNNEL_PROTOCOL_VERSION),
    relay: payload.relayUrl,
    host: payload.hostId,
    token: payload.pairingToken,
    psk: payload.psk,
    exp: String(payload.expiresAt),
    name: payload.displayName,
  });
  return `${PAIRING_URL_PREFIX}${params.toString()}`;
}

/** 解析二维码字符串；任何字段缺失/非法都返回 null，由调用方呈现统一的"无效配对码"。 */
export function parsePairingUrl(url: string): PairingPayload | null {
  if (!url.startsWith(PAIRING_URL_PREFIX)) return null;
  const params = new URLSearchParams(url.slice(PAIRING_URL_PREFIX.length));
  const version = Number(params.get("v"));
  if (version !== TUNNEL_PROTOCOL_VERSION) return null;
  const expiresAt = Number(params.get("exp"));
  const relayUrl = params.get("relay");
  const parsed = pairingPayloadSchema.safeParse({
    relayUrl,
    hostId: params.get("host"),
    pairingToken: params.get("token"),
    psk: params.get("psk"),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    displayName: params.get("name"),
  });
  return parsed.success ? parsed.data : null;
}

// ============================================================================
// 控制通道帧：宿主 ↔ relay（JSON text 帧）
// ============================================================================

export const tunnelErrorCodeSchema = z.enum([
  "hostOffline",
  "invalidHostCredential",
  "invalidSessionCredential",
  "pairingTokenInvalid",
  "connectTokenInvalid",
  "protocolMismatch",
]);
export type TunnelErrorCode = z.infer<typeof tunnelErrorCodeSchema>;

/** 宿主 → relay 控制帧。 */
export const hostControlFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hostHello"),
      hostId: z.string().trim().min(1).max(128),
      /** 宿主凭证：relay 只存哈希；首连由 relay 签发并经此通道下发。 */
      hostCredential: z.string(),
      displayName: z.string().trim().min(1).max(128),
      protocolVersion: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("pairingTokenRegister"),
      pairingTokenHash: z.string().min(32).max(128),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("ping"), sentAt: z.number().int() }).strict(),
]);
export type HostControlFrame = z.infer<typeof hostControlFrameSchema>;

/** relay → 宿主控制帧。 */
export const relayHostFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hostReady"),
      /** 首次注册时下发宿主凭证；已注册则为空串，宿主沿用本地凭证。 */
      issuedHostCredential: z.string(),
      serverTime: z.number().int(),
    })
    .strict(),
  z.object({ type: z.literal("streamOpen"), streamId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal("streamClosed"), streamId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal("pong"), sentAt: z.number().int() }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: tunnelErrorCodeSchema,
      message: z.string().max(512).optional(),
    })
    .strict(),
]);
export type RelayHostFrame = z.infer<typeof relayHostFrameSchema>;

// ============================================================================
// 数据面：浏览器 ↔ relay ↔ 宿主（拼接管道，业务字节对 relay 不透明）
// ============================================================================

/** 浏览器数据面 WS 首帧（text）：只携带路由与鉴权元数据，业务流量走后续二进制帧。 */
export const tunnelClientHelloSchema = z
  .object({
    type: z.literal("tunnelClientHello"),
    hostId: z.string().trim().min(1).max(128),
    /** 一次性连接票据（控制面换取），不使用长期会话凭证。 */
    connectToken: z.string().min(32).max(128),
    protocolVersion: z.number().int(),
  })
  .strict();
export type TunnelClientHello = z.infer<typeof tunnelClientHelloSchema>;

/** relay → 浏览器数据面应答（text 首帧）。 */
export const relayClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tunnelConnected"), streamId: z.string().min(1).max(64) }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: tunnelErrorCodeSchema,
      message: z.string().max(512).optional(),
    })
    .strict(),
]);
export type RelayClientFrame = z.infer<typeof relayClientFrameSchema>;

/** 端到端握手帧：密钥派生成功后的第一个加密帧，双方各发一次确认 PSK 一致。 */
export const e2eHelloFrameSchema = z
  .object({ type: z.literal("e2e-hello"), protocolVersion: z.number().int() })
  .strict();
export type E2eHelloFrame = z.infer<typeof e2eHelloFrameSchema>;

// ============================================================================
// 控制面 REST：配对 / 会话凭证（M1 TTL + 吊销，M2 补 refresh 与设备列表）
// ============================================================================

export const pairRequestSchema = z
  .object({ hostId: z.string().trim().min(1).max(128), pairingToken: z.string().min(32).max(128) })
  .strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const pairResultSchema = z
  .object({
    sessionCredential: z.string().min(32).max(256),
    expiresAt: z.number().int().positive(),
    hostDisplayName: z.string().trim().min(1).max(128),
  })
  .strict();
export type PairResult = z.infer<typeof pairResultSchema>;

export const connectTokenRequestSchema = z
  .object({ sessionCredential: z.string().min(32).max(256) })
  .strict();
export type ConnectTokenRequest = z.infer<typeof connectTokenRequestSchema>;

export const connectTokenResultSchema = z
  .object({ connectToken: z.string().min(32).max(256), expiresAt: z.number().int().positive() })
  .strict();
export type ConnectTokenResult = z.infer<typeof connectTokenResultSchema>;

// ============================================================================
// 纯函数：secret 生成 / 哈希（WebCrypto，node 与浏览器同构）
// ============================================================================

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function generateTunnelSecret(byteLength: number = TUNNEL_CONSTANTS.secretBytes): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** relay 侧只存哈希不存原文：配对 token、宿主/会话凭证一律先过这里。 */
export async function hashTunnelSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return toBase64Url(new Uint8Array(digest));
}
