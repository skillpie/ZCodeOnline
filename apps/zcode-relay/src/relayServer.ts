// relay 控制面 REST + 服务装配（specs/web-tunnel.md §3.1 控制面、§3.3 配对时序 5-6）。
// 数据面不解析业务流量；控制面只处理配对、票据与吊销，全部鉴权状态哈希存储。
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket, WebSocketServer } from "ws";
import {
  TUNNEL_CONSTANTS,
  connectTokenRequestSchema,
  connectTokenResultSchema,
  generateTunnelSecret,
  hashTunnelSecret,
  pairRequestSchema,
  pairResultSchema,
} from "@zcode/shared";
import { createReferenceAccountTokenVerifier, type VerifyAccountToken } from "./accountToken.js";
import { createRelayChannels, type RelayChannels } from "./relayChannels.js";
import {
  BindingStore,
  ConnectTokenStore,
  HostRegistry,
  PairingTokenStore,
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
  const verifyAccountToken = options.verifyAccountToken ?? createReferenceAccountTokenVerifier(now);
  const stores = {
    pairingTokens: new PairingTokenStore(),
    connectTokens: new ConnectTokenStore(),
    sessions: new SessionStore(),
    bindings: new BindingStore(),
    hosts: new HostRegistry(),
  };
  const channels = createRelayChannels({ now, ...stores });

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });

  app.post("/api/v1/pair", async (context) => {
    const identity = await verifyAccountToken(bearerToken(context.req.header("authorization")));
    if (!identity) return context.json({ error: "unauthorized" }, 401);
    const body = pairRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "invalid request" }, 400);
    const hostId = stores.pairingTokens.consume(
      await hashTunnelSecret(body.data.pairingToken),
      now(),
    );
    if (!hostId) return context.json({ error: "pairingTokenInvalid" }, 401);
    const host = stores.hosts.get(hostId);
    if (!host) return context.json({ error: "pairingTokenInvalid" }, 401);
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
