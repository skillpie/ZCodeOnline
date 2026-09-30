import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  releaseCatalogSchema,
  type ReleaseCatalog,
  type ReleaseCatalogEntry,
} from "../contracts.js";

function emptyReleaseCatalog(): ReleaseCatalog {
  return releaseCatalogSchema.parse({ schemaVersion: 1, releases: [] });
}

export function parseReleaseCatalog(raw: string): ReleaseCatalog {
  return releaseCatalogSchema.parse(JSON.parse(raw));
}

/**
 * 合并单个 target 的发行条目：同 target 旧条目被本次 staging 的条目替换，
 * 其他 target 保留（支持 RELEASE_TARGETS 部分发布后 catalog 仍覆盖全平台）。
 * 输出按版本升序排序，保证文件内容对同一组输入稳定（rsync/MD5 比对友好）。
 */
export function mergeReleaseCatalogEntry(
  catalog: ReleaseCatalog,
  entry: ReleaseCatalogEntry,
): ReleaseCatalog {
  const releases = [
    ...catalog.releases.filter((existing) => existing.target !== entry.target),
    entry,
  ].sort((left, right) =>
    left.version === right.version
      ? left.target.localeCompare(right.target)
      : left.version.localeCompare(right.version, undefined, { numeric: true }),
  );
  return releaseCatalogSchema.parse({ schemaVersion: 1, releases });
}

/** 读 → 合并 → 原子落盘；已有文件损坏时直接报错，不静默丢弃已发布条目。 */
export async function upsertReleaseCatalogEntry(
  catalogFile: string,
  entry: ReleaseCatalogEntry,
): Promise<ReleaseCatalog> {
  let catalog: ReleaseCatalog;
  try {
    catalog = parseReleaseCatalog(await readFile(catalogFile, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      catalog = emptyReleaseCatalog();
    } else {
      throw new Error(`Release catalog at ${catalogFile} is invalid; fix or delete it`, {
        cause: error,
      });
    }
  }
  const merged = mergeReleaseCatalogEntry(catalog, entry);
  await mkdir(dirname(catalogFile), { recursive: true });
  await writeFile(catalogFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}
