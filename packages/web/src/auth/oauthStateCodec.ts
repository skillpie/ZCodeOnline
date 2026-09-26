import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

const PRODUCTION_WEB_ORIGIN = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
const WEB_CALLBACK_PATHS = new Set(["/cn/share/callback", "/share/callback"]);
const SHARE_PATH_PATTERN = /^\/(?:cn\/share|share)\/[A-Za-z0-9._~-]{1,512}$/u;
const PRIVATE_DEV_RETURN_TO_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/;

interface OAuthStatePayload {
  nonce: string;
  app_return_to?: string;
  return_to?: string;
}

function getCurrentOrigin(): string {
  const location = globalThis.window?.location ?? globalThis.location;
  return location?.origin ?? PRODUCTION_WEB_ORIGIN;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

export function buildOAuthState(payload: OAuthStatePayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

export function parseOAuthState(state: string): OAuthStatePayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(state)) as Partial<OAuthStatePayload>;
    if (!isNonEmptyString(parsed.nonce)) {
      return null;
    }

    return {
      nonce: parsed.nonce,
      ...(isNonEmptyString(parsed.app_return_to) ? { app_return_to: parsed.app_return_to } : {}),
      ...(isNonEmptyString(parsed.return_to) ? { return_to: parsed.return_to } : {}),
    };
  } catch {
    return null;
  }
}

export function parseOptionalUrl(value?: string): URL | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isTrustedDevReturnTo(url: URL): boolean {
  return PRIVATE_DEV_RETURN_TO_PATTERN.test(url.toString()) && WEB_CALLBACK_PATHS.has(url.pathname);
}

interface OAuthCodecEnv {
  VITE_TRUSTED_RETURN_ORIGINS?: string;
}

/**
 * 构建期受信回跳 origin（回调页所在部署注入，逗号分隔）。
 *
 * 浏览器 OAuth 的 redirect_uri 固定注册在官方域，回调页因此常运行在官方构建上；
 * 自建域（隧道入口）的登录回跳只能由回调页构建的受信白名单放行——运行时不接受
 * 任意 origin，防止授权回调沦为开放重定向。specs/web-tunnel.md §5.7 登录回跳。
 */
function readTrustedReturnOrigins(env: unknown): readonly string[] {
  const raw = (env as OAuthCodecEnv | undefined)?.VITE_TRUSTED_RETURN_ORIGINS?.trim() ?? "";
  if (raw === "") return [];
  return raw
    .split(",")
    .map(normalizeTrustedOrigin)
    .filter((entry): entry is string => entry !== null);
}

/** 归一化单个受信 origin：容忍尾斜缀与空白，非合法 URL 丢弃。 */
function normalizeTrustedOrigin(entry: string): string | null {
  const trimmed = entry.trim().replace(/\/$/, "");
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

const MODULE_TRUSTED_RETURN_ORIGINS = readTrustedReturnOrigins(
  (import.meta as ImportMeta & { env?: OAuthCodecEnv }).env,
);

function resolveAllowedAppReturnOrigin(currentOrigin: string): string {
  return currentOrigin === PRODUCTION_WEB_ORIGIN ? PRODUCTION_WEB_ORIGIN : currentOrigin;
}

export interface ResolveSafeAppReturnToOptions {
  currentOrigin?: string;
  /** 覆盖构建期白名单（测试与未来多域策略注入用）；缺省读 VITE_TRUSTED_RETURN_ORIGINS。 */
  trustedOrigins?: readonly string[];
}

export function resolveSafeAppReturnTo(
  value?: string,
  options: ResolveSafeAppReturnToOptions = {},
): string | null {
  const url = parseOptionalUrl(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  // URL 里内嵌凭据（user:pass@host）一律拒绝，避免白名单匹配被仿冒 origin 混过。
  if (url.username !== "" || url.password !== "") {
    return null;
  }

  const currentOrigin = options.currentOrigin ?? getCurrentOrigin();
  // 同源：维持分享流既有语义——仅 share 路径，返回站内路径（沿用 location.replace(path)）。
  if (url.origin === resolveAllowedAppReturnOrigin(currentOrigin) || url.origin === currentOrigin) {
    if (!SHARE_PATH_PATTERN.test(url.pathname)) {
      return null;
    }
    return url.pathname;
  }

  // 跨域受信 origin（自建隧道域）：整域放行（含路径与查询串），返回完整 URL 跳回。
  const trustedOrigins = (options.trustedOrigins ?? MODULE_TRUSTED_RETURN_ORIGINS)
    .map(normalizeTrustedOrigin)
    .filter((entry): entry is string => entry !== null);
  if (trustedOrigins.includes(url.origin)) {
    return url.toString();
  }
  return null;
}

export function buildReturnToCallbackUrl(
  returnTo: string,
  params: { code?: string; error?: string; state: string },
): string | null {
  const returnToUrl = parseOptionalUrl(returnTo);
  if (!returnToUrl || !isTrustedDevReturnTo(returnToUrl) || !isNonEmptyString(params.state)) {
    return null;
  }

  returnToUrl.search = "";
  if (isNonEmptyString(params.code)) {
    returnToUrl.searchParams.set("code", params.code);
  }
  if (isNonEmptyString(params.error)) {
    returnToUrl.searchParams.set("error", params.error);
  }
  returnToUrl.searchParams.set("state", params.state);

  return returnToUrl.toString();
}
