// 配对会话（specs/web-tunnel.md §3.3）：生成一次性 token + PSK 二维码载荷，
// 经控制通道预登记 token 哈希；浏览器扫码 + 账号登录后 relay 完成绑定。
// token 原文只进二维码，relay 只见哈希；PSK 是宿主身份的一部分，同样只进二维码。
import {
  TUNNEL_CONSTANTS,
  buildPairingUrl,
  generateTunnelSecret,
  hashTunnelSecret,
  pairingPayloadSchema,
  type PairingPayload,
} from "@zcode/shared";
import type { TunnelConnector } from "./tunnelConnector.js";

export interface PairingSession {
  payload: PairingPayload;
  /** 扫码内容：zcode-tunnel://pair?... */
  url: string;
  expiresAt: number;
}

export interface PairingSessionHandle extends PairingSession {
  /** 过期或配对完成后调用：清掉连接器内的待登记 token。 */
  dispose(): void;
}

export interface StartPairingOptions {
  connector: TunnelConnector;
  hostId: string;
  displayName: string;
  now?: () => number;
}

/**
 * 发起一次配对会话。token 哈希存放在连接器上：控制通道每次 hostReady（含重连）
 * 都会自动补登记，"扫码期间 relay 恰好重启"这类时序不会破坏配对。
 */
export async function startPairingSession(
  options: StartPairingOptions,
): Promise<PairingSessionHandle> {
  const expiresAt = (options.now ?? Date.now)() + TUNNEL_CONSTANTS.pairingTokenTtlMs;
  const pairingToken = generateTunnelSecret();
  const payload = pairingPayloadSchema.parse({
    relayUrl: options.connector.relayUrl,
    hostId: options.hostId,
    pairingToken,
    psk: options.connector.psk,
    expiresAt,
    displayName: options.displayName,
  });
  options.connector.setPairingToken(await hashTunnelSecret(pairingToken), expiresAt);
  return {
    payload,
    url: buildPairingUrl(payload),
    expiresAt,
    dispose() {
      options.connector.clearPairingToken();
    },
  };
}
