// relay 的全部内存状态（specs/web-tunnel.md §2 状态所有者表）。
// 唯一持久状态是设备-账号绑定与凭证（鉴权范畴，非业务状态）；参考实现驻内存，
// 重启即失效——宿主与浏览器会重新配对，生产部署在此接口后换持久化实现。

export interface HostRegistration {
  hostId: string;
  hostCredentialHash: string;
  displayName: string;
}

export interface SessionRecord {
  user: string;
  hostId: string;
  credentialHash: string;
  expiresAt: number;
}

export interface BindingRecord {
  user: string;
  hostId: string;
  displayName: string;
}

/** 一次性消费语义统一为"先删除再判定"：过期、重放、未知都返回 miss（对齐 hostCapability）。 */
export function consumeOneTime<T extends { expiresAt: number }>(
  map: Map<string, T>,
  key: string | undefined,
  now: number,
): T | null {
  if (!key) return null;
  const record = map.get(key);
  map.delete(key);
  if (!record || record.expiresAt <= now) return null;
  return record;
}

export function purgeExpired<T extends { expiresAt: number }>(
  map: Map<string, T>,
  now: number,
): void {
  for (const [key, record] of map) {
    if (record.expiresAt <= now) map.delete(key);
  }
}

/** 宿主注册：hostId → 凭证哈希 + 展示名。凭证原文只在宿主本地。 */
export class HostRegistry {
  private readonly hosts = new Map<string, HostRegistration>();

  register(host: HostRegistration): void {
    this.hosts.set(host.hostId, host);
  }

  get(hostId: string): HostRegistration | null {
    return this.hosts.get(hostId) ?? null;
  }
}

/** 一次性配对 token（宿主经控制通道预登记，哈希存储）。 */
export class PairingTokenStore {
  private readonly byHash = new Map<string, { hostId: string; expiresAt: number }>();

  register(hash: string, hostId: string, expiresAt: number, now: number): void {
    purgeExpired(this.byHash, now);
    this.byHash.set(hash, { hostId, expiresAt });
  }

  /** 返回 token 所属 hostId；无效/过期/重放返回 null。 */
  consume(hash: string | undefined, now: number): string | null {
    return consumeOneTime(this.byHash, hash, now)?.hostId ?? null;
  }
}

/** 会话凭证：TTL 内可重复校验（区别于一次性票据），吊销按 (user, hostId) 整组失效。 */
export class SessionStore {
  private readonly byHash = new Map<string, SessionRecord>();

  issue(
    credentialHash: string,
    record: Omit<SessionRecord, "credentialHash">,
    now: number,
  ): number {
    purgeExpired(this.byHash, now);
    this.byHash.set(credentialHash, { ...record, credentialHash });
    return record.expiresAt;
  }

  verify(credentialHash: string | undefined, now: number): SessionRecord | null {
    if (!credentialHash) return null;
    const record = this.byHash.get(credentialHash);
    if (!record || record.expiresAt <= now) return null;
    return record;
  }

  revokeByHost(hostId: string): void {
    for (const [hash, record] of this.byHash) {
      if (record.hostId === hostId) this.byHash.delete(hash);
    }
  }
}

/** 设备-账号绑定：relay 控制面的唯一持久状态（参考实现驻内存）。 */
export class BindingStore {
  private readonly bindings = new Map<string, BindingRecord>();

  private static key(user: string, hostId: string): string {
    return `${user}\u0000${hostId}`;
  }

  bind(record: BindingRecord): void {
    this.bindings.set(BindingStore.key(record.user, record.hostId), record);
  }

  listForUser(user: string): BindingRecord[] {
    return [...this.bindings.values()].filter((record) => record.user === user);
  }

  isBound(user: string, hostId: string): boolean {
    return this.bindings.has(BindingStore.key(user, hostId));
  }

  unbind(user: string, hostId: string): boolean {
    return this.bindings.delete(BindingStore.key(user, hostId));
  }
}

/** 一次性连接票据：让长期会话凭证不进 WS 握手 URL（防 relay access log 泄漏）。 */
export class ConnectTokenStore {
  private readonly byHash = new Map<string, { user: string; hostId: string; expiresAt: number }>();

  register(
    hash: string,
    record: { user: string; hostId: string },
    expiresAt: number,
    now: number,
  ): void {
    purgeExpired(this.byHash, now);
    this.byHash.set(hash, { ...record, expiresAt });
  }

  consume(hash: string | undefined, now: number): { user: string; hostId: string } | null {
    const record = consumeOneTime(this.byHash, hash, now);
    return record ? { user: record.user, hostId: record.hostId } : null;
  }
}

/** 数据面路由表：hostId → 控制通道，宿主断线即摘除，不持久化。 */
export class RouteTable<T> {
  private readonly routes = new Map<string, T>();

  setRoute(hostId: string, connection: T): T | null {
    const previous = this.routes.get(hostId) ?? null;
    this.routes.set(hostId, connection);
    return previous;
  }

  getRoute(hostId: string): T | null {
    return this.routes.get(hostId) ?? null;
  }

  removeRoute(hostId: string, connection: T): boolean {
    if (this.routes.get(hostId) !== connection) return false;
    this.routes.delete(hostId);
    return true;
  }
}
