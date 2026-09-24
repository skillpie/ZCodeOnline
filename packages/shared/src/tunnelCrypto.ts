// ZCode Web 隧道端到端加密（specs/web-tunnel.md §3.4）。
// PSK 只存在于配对二维码与两端本地，relay 全程只见密文。
// 只用 WebCrypto 标准原语（HKDF + AES-256-GCM），Node 与浏览器同构。
import { TUNNEL_CONSTANTS } from "./tunnel.js";

/** 密钥方向：双向独立密钥，杜绝同一密钥下 nonce 复用。 */
export type TunnelKeyDirection = "clientToHost" | "hostToClient";

const DIRECTION_INFO: Record<TunnelKeyDirection, string> = {
  clientToHost: "zcode/tunnel-e2e/v1/client-to-host",
  hostToClient: "zcode/tunnel-e2e/v1/host-to-client",
};

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 从 PSK 派生双向 AES-256 密钥。salt 绑定 hostId，info 绑定方向与算法代次，
 * 防止同一 PSK 在不同宿主/方向上派生出相同密钥。
 */
export async function deriveTunnelKeys(
  pskBase64Url: string,
  hostId: string,
): Promise<Record<TunnelKeyDirection, CryptoKey>> {
  const psk = base64UrlToBytes(pskBase64Url);
  if (psk.length < 32) throw new Error("Tunnel PSK must be at least 32 bytes");
  const hkdfKey = await crypto.subtle.importKey("raw", psk, "HKDF", false, ["deriveBits"]);
  const salt = new TextEncoder().encode(hostId);
  const keys = await Promise.all(
    (Object.keys(DIRECTION_INFO) as TunnelKeyDirection[]).map(async (direction) => {
      const bits = await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info: new TextEncoder().encode(DIRECTION_INFO[direction]),
        },
        hkdfKey,
        256,
      );
      return [
        direction,
        await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
          "encrypt",
          "decrypt",
        ]),
      ] as const;
    }),
  );
  return Object.fromEntries(keys) as Record<TunnelKeyDirection, CryptoKey>;
}

function seqToNonce(seq: number): Uint8Array<ArrayBuffer> {
  // 96-bit nonce = 4 字节固定前缀 + 64-bit BE 序号；方向分离下每密钥序号单调递增，绝不复用。
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(seq), false);
  return nonce;
}

function seqToFramePrefix(seq: number): Uint8Array<ArrayBuffer> {
  const prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setBigUint64(0, BigInt(seq), false);
  return prefix;
}

/**
 * 单向加解密器。帧格式 = [8 字节 BE 序号][AES-256-GCM 密文]，
 * AAD 绑定方向；解密强制序号严格递增，重放与乱序一律拒绝。
 */
export class TunnelCipher {
  private nextSeq = 0;
  private lastSeenSeq: number | null = null;

  constructor(
    private readonly key: CryptoKey,
    private readonly direction: TunnelKeyDirection,
  ) {}

  get sequence(): number {
    return this.nextSeq;
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    if (plaintext.byteLength > TUNNEL_CONSTANTS.maxFrameBytes) {
      throw new Error(`Tunnel frame exceeds ${TUNNEL_CONSTANTS.maxFrameBytes} bytes`);
    }
    if (this.nextSeq >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Tunnel cipher sequence exhausted");
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: seqToNonce(seq),
          additionalData: new TextEncoder().encode(this.direction),
        },
        this.key,
        // slice 归一为独立 ArrayBuffer 视图，规避 BufferSource 的 SharedArrayBuffer 泛型约束。
        plaintext.slice(),
      ),
    );
    const prefix = seqToFramePrefix(seq);
    const frame = new Uint8Array(prefix.length + ciphertext.length);
    frame.set(prefix, 0);
    frame.set(ciphertext, prefix.length);
    return frame;
  }

  async decrypt(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.byteLength < 8 + 16) {
      throw new Error("Tunnel frame too short");
    }
    const seq = Number(
      new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0, false),
    );
    // 严格递增：重放（≤ lastSeen）与乱序都拒绝。隧道底层 WS 本身保序，这里不为此放宽。
    if (this.lastSeenSeq !== null && seq <= this.lastSeenSeq) {
      throw new Error(`Tunnel frame sequence regression: ${seq} <= ${String(this.lastSeenSeq)}`);
    }
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: seqToNonce(seq),
          additionalData: new TextEncoder().encode(this.direction),
        },
        this.key,
        // slice 归一为独立 ArrayBuffer 视图，规避 BufferSource 泛型约束。
        frame.slice(8),
      ),
    );
    this.lastSeenSeq = seq;
    return plaintext;
  }
}
