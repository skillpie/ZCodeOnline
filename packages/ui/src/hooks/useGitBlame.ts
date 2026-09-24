/**
 * useGitBlameLineResolver —— git blame 行级解析（整文件一次取回 + 全局按路径缓存）。
 * 返回工厂：传入 workspacePath + 文件路径，得到该文件的行号解析函数
 * （行号 → { author, time, committed }；空结果 = 未跟踪新文件，所有行按「未提交」）。
 * 缓存全局共享（跨组件实例），容量上限 FIFO 淘汰，避免长会话无限增长。
 */
import { useCallback } from "react";
import type { LightweightDiffBlameInfo } from "@/components/ui/lightweight-diff-preview.js";
import { useServices } from "@/hooks/useServices.js";

const CACHE_MAX_ENTRIES = 50;
const cache = new Map<string, Promise<Map<number, LightweightDiffBlameInfo>>>();

export function useGitBlameLineResolver() {
  const { gitService } = useServices();

  return useCallback(
    (workspacePath: string, filePath: string): ((line: number) => Promise<LightweightDiffBlameInfo | null>) => {
      const key = `${workspacePath}\u0000${filePath}`;
      let cached = cache.get(key);
      if (!cached) {
        cached = gitService
          .getBlame({ workspacePath, path: filePath })
          .then((result) => {
            const map = new Map<number, LightweightDiffBlameInfo>();
            for (const entry of result?.lines ?? []) {
              map.set(entry.line, {
                author: entry.author,
                time: entry.time,
                committed: !entry.hash.startsWith("0000000"),
              });
            }
            // FIFO 淘汰
            if (cache.size >= CACHE_MAX_ENTRIES) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            return map;
          })
          .catch(() => new Map<number, LightweightDiffBlameInfo>());
        cache.set(key, cached);
      }
      const pending = cached;
      return (line: number) => {
        if (!pending) return Promise.resolve(null);
        return pending.then((map) => {
          // 空映射 = 未跟踪新文件：所有行都按「未提交」提示
          if (map.size === 0) {
            return { author: "", time: 0, committed: false };
          }
          return map.get(line) ?? null;
        });
      };
    },
    [gitService],
  );
}
