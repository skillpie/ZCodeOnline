// relay 装配入口：`pnpm --dir apps/zcode-relay dev`。
// 环境变量：ZCODE_RELAY_PORT（默认 8787）、ZCODE_RELAY_HOST（默认 127.0.0.1，公网部署须挂 TLS 反代）。
// 独立部署单元，不引 @zcode/services（避免拖入宿主依赖树）；日志走 stderr 最小实现。
import { createAnonymousAccountTokenVerifier } from "./accountToken.js";
import { startRelayServer } from "./relayServer.js";

function logInfo(message: string, fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level: "info", message, ...fields })}\n`);
}

// 配对鉴权模式：jwt（默认，配对需 ZAI 账号 JWT）/ none（配对码即唯一凭证，自有域名部署用）。
// ZCODE_RELAY_DEV_ACCEPT_ANY=1 保留为本地联调别名（等同 none，日志标记 dev）。
const pairingAuth = process.env.ZCODE_RELAY_PAIRING_AUTH?.trim() || "jwt";
const devAcceptAny = process.env.ZCODE_RELAY_DEV_ACCEPT_ANY === "1";
let verifyAccountToken;
if (pairingAuth === "none" || devAcceptAny) {
  verifyAccountToken = createAnonymousAccountTokenVerifier();
  logInfo("pairing auth disabled", {
    mode: devAcceptAny ? "dev-accept-any" : "none",
    note: "pairing code is the sole capability; host-side approval lands in M2",
  });
}

const server = await startRelayServer({
  port: Number(process.env.ZCODE_RELAY_PORT ?? 8787),
  host: process.env.ZCODE_RELAY_HOST ?? "127.0.0.1",
  ...(verifyAccountToken ? { verifyAccountToken } : {}),
});

logInfo("relay listening", { port: server.port });
