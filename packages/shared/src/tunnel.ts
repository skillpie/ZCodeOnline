// ZCode Web 隧道契约（specs/web-tunnel.md M1 数据面）。
// 本包纪律：只放 schema 类型 + 纯函数，禁止任何运行时/IO/传输逻辑。
// relay 只做鉴权、配对、心跳、转发；会话权威状态始终在本机宿主侧。
import { z } from "zod";

/**
 * 产品部署的默认 relay 入口：`zcode tunnel`/`tunnel-enable` 未显式指定时使用。
 * 可被 ZCODE_RELAY_URL 环境变量或 --relay-url 覆盖（自建 relay / 本地联调）。
 */
export const DEFAULT_TUNNEL_RELAY_URL = "wss://zcode.skillpie.cn/relay";

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
  /**
   * 管道内单帧业务密文上限：必须宽松于直连 ws 路径（后者无上限）——加密层加严上限
   * 会让大响应（文件/快照）在直连可用而隧道断流。64MB 覆盖全部业务载荷。
   */
  maxFrameBytes: 64 * 1024 * 1024,
  /** 宿主取 server-info 组装 bootstrap 帧的预算；超时则不发送（浏览器按无 bootstrap 继续）。 */
  bootstrapFetchTimeoutMs: 2_000,
  /** 本地配对发现端口的探测超时（浏览器 → 127.0.0.1，宿主未运行时快速失败）。 */
  discoveryTimeoutMs: 1_500,
  /** 浏览器等待 bootstrap 帧的窗口（须大于宿主侧 fetch 预算；旧宿主不发帧时按超时继续）。 */
  bootstrapWaitTimeoutMs: 5_000,
  /** 随机 secret 字节数（配对 token / PSK / 凭证）。 */
  secretBytes: 32,
} as const;

// ============================================================================
// 配对载荷（二维码 / 短码的编解码内容）
// ============================================================================

/**
 * 本地配对发现端点（specs/web-tunnel.md §5.8）：宿主在 127.0.0.1:<discoveryPort> 上
 * 提供 GET /tunnel/pairing，每次调用生成新鲜的一次性配对会话。仅限回环访问 +
 * 允许 origin 的 CORS 白名单（浏览器沙箱读不了本地文件，这是"打开网站自动配对"的标准实现）。
 */
export const TUNNEL_DISCOVERY_PORT = 4950;
export const TUNNEL_DISCOVERY_ALLOWED_ORIGINS = [
  "https://zcode.skillpie.cn",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

export const tunnelDiscoveryResponseSchema = z
  .object({
    pairingUrl: z.string().min(32),
    expiresAt: z.number().int().positive(),
    hostId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(128),
  })
  .strict();
export type TunnelDiscoveryResponse = z.infer<typeof tunnelDiscoveryResponseSchema>;

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
  z
    .object({
      type: z.literal("assistRegister"),
      assistCodeHash: z.string().min(32).max(128),
      maskedPsk: z.string().min(32).max(128),
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

/**
 * E2E 握手后的宿主 → 浏览器引导帧（明文形态；线上以既有帧格式加密传输）：
 * 隧道只承载 WS RPC，server-info 无法经同源 REST 获取，由宿主连接器代取后下发，
 * 浏览器据此注入 initialWorkspace（对齐正常 web 流程的 /api/server-info 语义）。
 */
export const tunnelBootstrapFrameSchema = z
  .object({
    type: z.literal("tunnelBootstrap"),
    workspaces: z
      .array(
        z
          .object({
            path: z.string().min(1),
            workspaceIdentity: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type TunnelBootstrapFrame = z.infer<typeof tunnelBootstrapFrameSchema>;

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
// 远程协助（specs/web-tunnel.md §5.9）：16 位码 = 一次性跨用户能力凭证。
// ============================================================================

/** 远程码长度（数字位数；10^16 ≈ 2^53 熵 + relay 每 IP 限流）。 */
export const TUNNEL_ASSIST_CODE_LENGTH = 16;
/**
 * 远程码长期有效（specs/web-tunnel.md §5.9 持久机器码）：直到用户「刷新」轮换或解绑。
 * expiresAt 仅为协议兼容字段（填远期）；真正的失效 = 轮换/宿主解绑/隧道停跑。
 */
export const TUNNEL_ASSIST_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** 归一化：去空白/连字符，仅保留数字；非法输入返回 null。 */
export function normalizeAssistCode(input: string): string | null {
  const digits = input.replaceAll(/[^0-9]/gu, "");
  return digits.length === TUNNEL_ASSIST_CODE_LENGTH ? digits : null;
}

/** 生成 16 位随机数字码（展示按 4-4-4-4 分组，传输/存储用归一化形态）。 */
export function generateAssistCode(): string {
  let code = "";
  while (code.length < TUNNEL_ASSIST_CODE_LENGTH) {
    const bytes = new Uint8Array(TUNNEL_ASSIST_CODE_LENGTH - code.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) code += String(byte % 10);
  }
  return code;
}

/** 展示格式：1234 5678 9012 3456。 */
export function formatAssistCode(code: string): string {
  const normalized = normalizeAssistCode(code) ?? code;
  return (normalized.match(/.{1,4}/gu) ?? [normalized]).join(" ");
}

/** XOR 掩码：masked = input ⊕ SHA-256(code)。relay 无法从掩码与哈希还原 psk。 */
async function xorWithCodeHash(inputBase64Url: string, code: string): Promise<string> {
  const mask = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
  );
  const normalized = inputBase64Url.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const input = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    input[index] = binary.charCodeAt(index);
  }
  const masked = input.map((byte, index) => byte ^ mask[index % mask.length]!);
  let out = "";
  for (const byte of masked) out += String.fromCharCode(byte);
  return btoa(out).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 宿主侧：psk → maskedPsk（relay 只见掩码，缺码原像不可还原）。 */
export function maskAssistPsk(pskBase64Url: string, code: string): Promise<string> {
  return xorWithCodeHash(pskBase64Url, code);
}

/** B 侧：maskedPsk ⊕ SHA-256(code) → psk。 */
export function revealAssistPsk(maskedBase64Url: string, code: string): Promise<string> {
  return xorWithCodeHash(maskedBase64Url, code);
}

// 控制通道：宿主 → relay 预登记远程协助邀请（覆盖同 hostId 旧邀请）。
export const assistRegisterFrameSchema = z
  .object({
    type: z.literal("assistRegister"),
    assistCodeHash: z.string().min(32).max(128),
    maskedPsk: z.string().min(32).max(128),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AssistRegisterFrame = z.infer<typeof assistRegisterFrameSchema>;

// B 兑换：POST /api/v1/assist/connect。
// max(64)：允许分组格式（含空格/连字符）；归一化后不足 16 位 → 与未知码同响应（防枚举）。
export const assistConnectRequestSchema = z.object({ code: z.string().min(4).max(64) }).strict();
export const assistConnectResultSchema = z
  .object({
    hostId: z.string().trim().min(1).max(128),
    connectToken: z.string().min(32).max(256),
    maskedPsk: z.string().min(32).max(128),
  })
  .strict();
export type AssistConnectResult = z.infer<typeof assistConnectResultSchema>;

/** 发现端点：A 侧展示自己的远程码。 */
export const assistCodeResponseSchema = z
  .object({ code: z.string().min(16).max(16), expiresAt: z.number().int().positive() })
  .strict();
export type TunnelAssistCode = z.infer<typeof assistCodeResponseSchema>;

// ============================================================================
// 桌面管理面（specs/web-tunnel.md §5.5 路线 B）：IPlatformService 的隧道管理契约。
// daemon 不可达时 tunnelStatus 返回 daemonReachable=false 的全空状态，enable/pair 抛错。
// ============================================================================

export interface TunnelManagerStatus {
  /** server-cli daemon 控制端点是否可达；false 时其余字段无意义。 */
  daemonReachable: boolean;
  enabled: boolean;
  connected: boolean;
  relayUrl: string | null;
  hostId: string;
  displayName: string;
}

export interface TunnelManagerPairing {
  pairingUrl: string;
  expiresAt: number;
}

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
