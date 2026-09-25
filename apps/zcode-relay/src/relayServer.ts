// relay 控制面 REST + 服务装配（specs/web-tunnel.md §3.1 控制面、§3.3 配对时序 5-6）。
// 数据面不解析业务流量；控制面只处理配对、票据与吊销，全部鉴权状态哈希存储。
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket, WebSocketServer } from "ws";
import {
  TUNNEL_CONSTANTS,
  TUNNEL_DISCOVERY_ALLOWED_ORIGINS,
  assistConnectRequestSchema,
  assistConnectResultSchema,
  normalizeAssistCode,
  connectTokenRequestSchema,
  connectTokenResultSchema,
  generateTunnelSecret,
  hashTunnelSecret,
  pairRequestSchema,
  pairResultSchema,
} from "@zcode/shared";
import { createReferenceAccountTokenVerifier, type VerifyAccountToken } from "./accountToken.js";
import { createRelayLogger } from "./relayLog.js";
import { createRelayChannels, type RelayChannels } from "./relayChannels.js";
import {
  AssistInvitationStore,
  BindingStore,
  ConnectTokenStore,
  HostRegistry,
  PairingTokenStore,
  RateLimiter,
  SessionStore,
} from "./tunnelStore.js";

export interface RelayServerOptions {
  port?: number;
  host?: string;
  now?: () => number;
  verifyAccountToken?: VerifyAccountToken;
}

export interface RelayServer {
  readonly port: number;
  readonly stores: {
    pairingTokens: PairingTokenStore;
    connectTokens: ConnectTokenStore;
    sessions: SessionStore;
    bindings: BindingStore;
    hosts: HostRegistry;
  };
  readonly channels: RelayChannels;
  close(): Promise<void>;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close(1001, "Server shutting down");
  return new Promise((resolve) => {
    // 已 close 的客户端在下一个 tick 内清空；参考实现不追求优雅排空。
    setTimeout(() => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    }, 20);
  });
}

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const now = options.now ?? Date.now;
  const log = createRelayLogger("relay");
  const verifyAccountToken = options.verifyAccountToken ?? createReferenceAccountTokenVerifier(now);
  const stores = {
    assistInvitations: new AssistInvitationStore(),
    pairingTokens: new PairingTokenStore(),
    connectTokens: new ConnectTokenStore(),
    sessions: new SessionStore(),
    bindings: new BindingStore(),
    hosts: new HostRegistry(),
  };
  const channels = createRelayChannels({ now, ...stores });

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });

  // 控制面 CORS：生产页为同源，但 dev（localhost:5173）与自建部署是跨源——
  // 白名单 origin 放行（配对仍需账号 token 或一次性配对码，CORS 只防读取不防滥用）。
  app.use(
    "/api/v1/*",
    cors({
      origin: [...TUNNEL_DISCOVERY_ALLOWED_ORIGINS],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization"],
      maxAge: 600,
    }),
  );

  app.post("/api/v1/pair", async (context) => {
    const identity = await verifyAccountToken(bearerToken(context.req.header("authorization")));
    if (!identity) return context.json({ error: "unauthorized" }, 401);
    const body = pairRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "invalid request" }, 400);
    const tokenHash = await hashTunnelSecret(body.data.pairingToken);
    const hostId = stores.pairingTokens.consume(tokenHash, now());
    if (!hostId) {
      log.warn("pair rejected", { reason: "tokenInvalidOrExpired" });
      return context.json({ error: "pairingTokenInvalid" }, 401);
    }
    const host = stores.hosts.get(hostId);
    if (!host) {
      log.warn("pair rejected", { reason: "hostUnknown", hostId });
      return context.json({ error: "pairingTokenInvalid" }, 401);
    }
    log.info("pair accepted", { hostId, user: identity.userId });
    const credential = generateTunnelSecret();
    stores.sessions.issue(
      await hashTunnelSecret(credential),
      {
        user: identity.userId,
        hostId,
        expiresAt: now() + TUNNEL_CONSTANTS.sessionCredentialTtlMs,
      },
      now(),
    );
    stores.bindings.bind({ user: identity.userId, hostId, displayName: host.displayName });
    return context.json(
      pairResultSchema.parse({
        sessionCredential: credential,
        expiresAt: now() + TUNNEL_CONSTANTS.sessionCredentialTtlMs,
        hostDisplayName: host.displayName,
      }),
    );
  });

  app.post("/api/v1/tunnel/connect-token", async (context) => {
    const body = connectTokenRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "invalid request" }, 400);
    const session = stores.sessions.verify(
      await hashTunnelSecret(body.data.sessionCredential),
      now(),
    );
    if (!session) return context.json({ error: "invalidSessionCredential" }, 401);
    const connectToken = generateTunnelSecret();
    stores.connectTokens.register(
      await hashTunnelSecret(connectToken),
      { user: session.user, hostId: session.hostId },
      now() + TUNNEL_CONSTANTS.connectTokenTtlMs,
      now(),
    );
    return context.json(
      connectTokenResultSchema.parse({
        connectToken,
        expiresAt: now() + TUNNEL_CONSTANTS.connectTokenTtlMs,
      }),
    );
  });

  // 远程协助兑换（specs/web-tunnel.md §5.9）：码 = 一次性能力；单码单用户 + 每 IP 限流。
  const assistRateLimiter = new RateLimiter(60_000, 20);
  app.post("/api/v1/assist/connect", async (context) => {
    const ip =
      context.req.header("x-real-ip")?.trim() ||
      context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    if (!assistRateLimiter.allow(ip, now())) {
      return context.json({ error: "rate limited" }, 429);
    }
    const body = assistConnectRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "invalid request" }, 400);
    const normalized = normalizeAssistCode(body.data.code);
    const codeHash = normalized ? await hashTunnelSecret(normalized) : "";
    const invitation = normalized ? stores.assistInvitations.verify(codeHash, now()) : null;
    if (!invitation) return context.json({ error: "assistCodeInvalid" }, 401);
    const connectToken = generateTunnelSecret();
    stores.connectTokens.register(
      await hashTunnelSecret(connectToken),
      { user: `assist:${invitation.hostId}`, hostId: invitation.hostId },
      now() + TUNNEL_CONSTANTS.connectTokenTtlMs,
      now(),
    );
    log.info("assist accepted", { hostId: invitation.hostId });
    return context.json(
      assistConnectResultSchema.parse({
        hostId: invitation.hostId,
        connectToken,
        maskedPsk: invitation.maskedPsk,
      }),
    );
  });

  app.get("/api/v1/tunnel/devices", async (context) => {
    const identity = await verifyAccountToken(bearerToken(context.req.header("authorization")));
    if (!identity) return context.json({ error: "unauthorized" }, 401);
    return context.json({
      devices: stores.bindings.listForUser(identity.userId),
    });
  });

  app.delete("/api/v1/tunnel/devices/:hostId", async (context) => {
    const identity = await verifyAccountToken(bearerToken(context.req.header("authorization")));
    if (!identity) return context.json({ error: "unauthorized" }, 401);
    const hostId = context.req.param("hostId");
    stores.bindings.unbind(identity.userId, hostId);
    stores.sessions.revokeByHost(hostId);
    channels.closeHostStreams(hostId);
    return context.json({ ok: true });
  });

  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        channels.handleHostConnection(socket.raw as WebSocket);
      },
    })),
  );
  app.get(
    "/ws/host/stream/:streamId",
    upgradeWebSocket((context) => ({
      onOpen(_event, socket) {
        channels.handleHostStreamConnection(
          socket.raw as WebSocket,
          context.req.param("streamId") ?? "",
        );
      },
    })),
  );
  app.get(
    "/ws/tunnel/:hostId",
    upgradeWebSocket((context) => ({
      onOpen(_event, socket) {
        channels.handleBrowserConnection(
          socket.raw as WebSocket,
          context.req.param("hostId") ?? "",
        );
      },
    })),
  );

  const stopHeartbeat = channels.startHeartbeatSweep();
  const server = serve({
    fetch: app.fetch,
    port: options.port ?? 0,
    hostname: options.host ?? "127.0.0.1",
  });
  injectWebSocket(server);
  // port=0 时端口由内核分配，必须等 listening 后才能把真实端口交给调用方。
  await once(server, "listening");
  const resolvedPort = (server.address() as AddressInfo).port;

  return {
    port: resolvedPort,
    stores,
    channels,
    async close() {
      stopHeartbeat();
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
