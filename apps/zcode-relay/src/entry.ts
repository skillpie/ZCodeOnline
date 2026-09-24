// relay 装配入口：`pnpm --dir apps/zcode-relay dev`。
// 环境变量：ZCODE_RELAY_PORT（默认 8787）、ZCODE_RELAY_HOST（默认 127.0.0.1，公网部署须挂 TLS 反代）。
// 独立部署单元，不引 @zcode/services（避免拖入宿主依赖树）；日志走 stderr 最小实现。
import { startRelayServer } from "./relayServer.js";

function logInfo(message: string, fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level: "info", message, ...fields })}\n`);
}

const server = await startRelayServer({
  port: Number(process.env.ZCODE_RELAY_PORT ?? 8787),
  host: process.env.ZCODE_RELAY_HOST ?? "127.0.0.1",
});

logInfo("relay listening", { port: server.port });
