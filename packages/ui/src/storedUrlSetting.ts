// localStorage 持久化的 http(s) 链接设置（技能市场链接、自定义代码仓库等）。
// 每个设置一个 storage key，由各自模块持有唯一实例；归一化/读写统一在这里收口，
// 避免多处校验漂移。subscribe/getVersion 供 useSyncExternalStore 做跨组件响应。

export function normalizeExternalHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface StoredHttpUrlSetting {
  /** 读取当前值；未设置或 localStorage 不可用时返回 null。 */
  load(): string | null;
  /** 归一化后写入；非法输入不落库并返回 null，由调用方提示。 */
  save(value: string): string | null;
  clear(): void;
  subscribe(listener: () => void): () => void;
  /** 快照版本号：每次写入递增，作为 useSyncExternalStore 的 getSnapshot。 */
  getVersion(): number;
}

export function createStoredHttpUrlSetting(storageKey: string): StoredHttpUrlSetting {
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    version += 1;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    load() {
      try {
        return normalizeExternalHttpUrl(localStorage.getItem(storageKey) ?? "");
      } catch {
        return null;
      }
    },
    save(value) {
      const normalized = normalizeExternalHttpUrl(value);
      if (!normalized) {
        return null;
      }
      localStorage.setItem(storageKey, normalized);
      notify();
      return normalized;
    },
    clear() {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // 移除失败不影响语义：读不到即视为未设置。
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
  };
}
