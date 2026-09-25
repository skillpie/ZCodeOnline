// 账号身份校验接缝（specs/web-tunnel.md §4 M2）。
// M1 参考实现只解码 JWT payload 并校验 exp，不做签名验证——这是已知的宽松点，
// 生产部署前必须在 M2 换成 JWKS 验签 + issuer/audience 校验；接缝签名不变，替换不动调用方。

export interface AccountIdentity {
  userId: string;
}

export type VerifyAccountToken = (token: string | undefined) => Promise<AccountIdentity | null>;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1]!.replaceAll("-", "+").replaceAll("_", "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createReferenceAccountTokenVerifier(now = Date.now): VerifyAccountToken {
  return async (token) => {
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    if (!payload) return null;
    const exp = payload.exp;
    const sub = payload.sub;
    if (typeof exp !== "number" || exp * 1000 <= now()) return null;
    if (typeof sub !== "string" || sub.length === 0) return null;
    return { userId: sub };
  };
}

/**
 * 匿名配对模式（ZCODE_RELAY_PAIRING_AUTH=none）：跳过账号校验，配对码成为唯一能力凭证
 * （32 字节随机 + 短 TTL + 一次性）。适用于无 OAuth 回调的自有域名部署；开启时须在
 * 部署文档标注安全取舍。M2 以宿主侧配对确认替代账号门禁（specs/web-tunnel.md §3.3）。
 */
export function createAnonymousAccountTokenVerifier(): VerifyAccountToken {
  return async () => ({ userId: "anonymous" });
}

/**
 * 本地联调豁免（ZCODE_RELAY_DEV_ACCEPT_ANY=1 时启用）：跳过账号校验，所有配对请求
 * 归入固定本地用户。仅限本机参考 relay 使用——生产部署绝不可开启。
 */
export function createDevAnyAccountTokenVerifier(): VerifyAccountToken {
  return async () => ({ userId: "dev-local" });
}
