// 本地配对发现服务（specs/web-tunnel.md §5.8）：
// 127.0.0.1:<discoveryPort> 上的 GET /tunnel/pairing，每次调用生成新鲜的一次性配对会话，
// 浏览器打开 zcode.skillpie.cn 后自动探测并配对（等效"读本地文件"且不破坏浏览器沙箱）。
// 安全边界：仅回环绑定（局域网不可达）；CORS 白名单校验 Origin + PNA preflight
// （公网 HTTPS 页面访问本地端点需 Access-Control-Allow-Private-Network）；无账户凭证的
// 跨站请求即使绕过 CORS 也无法完成配对（relay /pair 需要用户账号 token）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TUNNEL_DISCOVERY_ALLOWED_ORIGINS,
  TUNNEL_DISCOVERY_PORT,
  assistCodeResponseSchema,
  tunnelDiscoveryResponseSchema,
} from "@zcode/shared";

export interface TunnelDiscoveryServerOptions {
  /** 生成新鲜配对会话；宿主未就绪（隧道禁用/连接中）时返回 null。 */
  pair: () => Promise<{
    pairingUrl: string;
    expiresAt: number;
    status: { hostId: string; displayName: string };
  } | null>;
  /** 远程协助（specs/web-tunnel.md §5.9）：取当前 16 位码 / 刷新。未提供则 assist 路由 404。 */
  assist?: {
    ensure: () => Promise<{ code: string; expiresAt: number }>;
    refresh: () => Promise<{ code: string; expiresAt: number }>;
  };
  port?: number;
  host?: string;
  /** 允许的浏览器 origin（CORS 白名单）；测试可注入。 */
  allowedOrigins?: readonly string[];
}

export interface TunnelDiscoveryServer {
  readonly port: number;
  close(): Promise<void>;
}

function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return typeof origin === "string" && (allowed as readonly string[]).includes(origin);
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-private-network": "true",
    vary: "Origin",
  });
  response.end(JSON.stringify(body));
}

export function startTunnelDiscoveryServer(
  options: TunnelDiscoveryServerOptions,
): Promise<TunnelDiscoveryServer> {
  const allowed = options.allowedOrigins ?? TUNNEL_DISCOVERY_ALLOWED_ORIGINS;
  const port = options.port ?? TUNNEL_DISCOVERY_PORT;

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse): void => {
      const origin = request.headers.origin;
      const allowedOrigin = isAllowedOrigin(origin, allowed) ? (origin as string) : "";
      const corsOrReject = (): void => {
        // 不在白名单的 origin：不允许读取响应（CORS 缺省即拒绝）；显式 403 便于诊断。
        if (!allowedOrigin) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "origin not allowed" }));
          return;
        }
        respondJson(response, 404, { error: "not found" }, allowedOrigin);
      };

      if (request.method === "OPTIONS") {
        if (!allowedOrigin) {
          response.writeHead(403);
          response.end();
          return;
        }
        response.writeHead(204, {
          "access-control-allow-origin": allowedOrigin,
          "access-control-allow-methods": "GET",
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
          vary: "Origin",
        });
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isPairing = request.method === "GET" && url.pathname === "/tunnel/pairing";
      const isAssist = request.method === "GET" && url.pathname === "/tunnel/assist";
      const isAssistRefresh =
        request.method === "POST" && url.pathname === "/tunnel/assist/refresh";
      if (!isPairing && !isAssist && !isAssistRefresh) {
        corsOrReject();
        return;
      }
      if (!allowedOrigin) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "origin not allowed" }));
        return;
      }
      if (isAssist || isAssistRefresh) {
        if (!options.assist) {
          respondJson(response, 404, { error: "assist unavailable" }, allowedOrigin);
          return;
        }
        void (isAssistRefresh ? options.assist.refresh() : options.assist.ensure())
          .then((invitation) => {
            respondJson(
              response,
              200,
              assistCodeResponseSchema.parse({
                code: invitation.code,
                expiresAt: invitation.expiresAt,
              }),
              allowedOrigin,
            );
          })
          .catch(() => {
            respondJson(response, 500, { error: "assist failed" }, allowedOrigin);
          });
        return;
      }
      void options
        .pair()
        .then((session) => {
          if (!session) {
            respondJson(response, 503, { error: "tunnel not ready" }, allowedOrigin);
            return;
          }
          respondJson(
            response,
            200,
            tunnelDiscoveryResponseSchema.parse({
              pairingUrl: session.pairingUrl,
              expiresAt: session.expiresAt,
              hostId: session.status.hostId,
              displayName: session.status.displayName,
            }),
            allowedOrigin,
          );
        })
        .catch(() => {
          respondJson(response, 500, { error: "pairing failed" }, allowedOrigin);
        });
    },
  );

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        // 端口被占（多实例）：隧道仍可用手动配对，发现端点非致命。
        resolve({ port, close: async () => undefined });
        return;
      }
      reject(error);
    });
    server.listen(port, options.host ?? "127.0.0.1", () => {
      // port=0 时内核分配真实端口，必须回读（调用方/测试用它发请求）。
      const assignedPort = (server.address() as AddressInfo).port;
      resolve({
        port: assignedPort,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
