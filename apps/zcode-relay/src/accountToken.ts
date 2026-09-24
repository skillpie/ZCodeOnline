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
