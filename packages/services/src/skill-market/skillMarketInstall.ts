/**
 * SkillPie 技能包（zip）下载后的本地安装流程：
 * 临时目录解压（yauzl）→ 定位含 SKILL.md 的技能目录 → 复制到用户级技能根。
 * 安全边界与 skill-sync 导入对齐：拒绝路径穿越/绝对路径条目、限制解压总量，
 * 目标目录名由服务端 normalizedName 给出且必须是单段安全路径。
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import type { SkillMarketInstallResult } from "@zcode/shared";
import { normalizeSkillSyncRelativePath } from "../skill-sync/skillSyncPath.js";

const SKILL_FILE_NAME = "SKILL.md";
/** 与 skillSyncService 的归档上限保持一致（skillpie 上传侧限制 10MB，此处留有余量）。 */
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;

export class SkillMarketPackageError extends Error {}

export interface InstallSkillPackageParams {
  archive: Uint8Array;
  normalizedName: string;
  name: string;
  versionNo: number | null;
  /** 用户级技能根目录（~/.zcode/skills）；注入以便测试。 */
  userSkillRoot: string;
}

export async function installSkillPackage(
  params: InstallSkillPackageParams,
): Promise<SkillMarketInstallResult> {
  const { archive, normalizedName, name, versionNo, userSkillRoot } = params;
  if (archive.byteLength === 0) {
    throw new SkillMarketPackageError("skill package is empty");
  }
  if (archive.byteLength > MAX_PACKAGE_BYTES) {
    throw new SkillMarketPackageError("skill package exceeds size limit");
  }
  // 目标目录名必须是不含分隔符的单段相对路径，防止 normalizedName 注入路径。
  const safeDirectoryName = normalizeSkillSyncRelativePath(normalizedName, {
    unsafePathLabel: "unsafe skill market directory name",
  });
  if (safeDirectoryName.includes("/")) {
    throw new SkillMarketPackageError(`unsafe skill market directory name: ${normalizedName}`);
  }
  const targetPath = resolve(userSkillRoot, safeDirectoryName);
  if (existsSync(targetPath)) {
    return { status: "already-installed", name, normalizedName, versionNo, path: targetPath };
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-skill-market-"));
  try {
    const extractRoot = join(tempRoot, "package");
    await extractZipArchive(archive, extractRoot);
    const sourceDir = await locateSkillDirectory(extractRoot);
    await mkdir(userSkillRoot, { recursive: true });
    await cp(sourceDir, targetPath, { recursive: true, errorOnExist: true, force: false });
    return { status: "installed", name, normalizedName, versionNo, path: targetPath };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/** 解压 zip 到目标目录；逐条目校验路径安全并限制解压总量与条目数。 */
async function extractZipArchive(archive: Uint8Array, targetDir: string): Promise<void> {
  const zip = await openZipBuffer(Buffer.from(archive));
  let extractedBytes = 0;
  let entryCount = 0;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const fail = (error: unknown) => {
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
      zip.close();
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        fail(new SkillMarketPackageError("skill package has too many entries"));
        return;
      }
      if (extractedBytes + entry.uncompressedSize > MAX_EXTRACTED_BYTES) {
        fail(new SkillMarketPackageError("skill package exceeds extracted size limit"));
        return;
      }
      let relativePath: string;
      try {
        relativePath = normalizeSkillSyncRelativePath(entry.fileName, {
          unsafePathLabel: "unsafe skill package entry",
        });
      } catch (error) {
        fail(error);
        return;
      }

      const targetPath = resolve(targetDir, ...relativePath.split("/"));
      const isDirectory = entry.fileName.endsWith("/");
      void (async () => {
        try {
          if (isDirectory) {
            await mkdir(targetPath, { recursive: true });
          } else {
            const stream = await openZipEntryStream(zip, entry);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(chunk as Buffer);
            }
            const content = Buffer.concat(chunks);
            extractedBytes += content.byteLength;
            if (extractedBytes > MAX_EXTRACTED_BYTES) {
              throw new SkillMarketPackageError("skill package exceeds extracted size limit");
            }
            await mkdir(join(targetPath, ".."), { recursive: true });
            await writeFile(targetPath, content);
          }
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    zip.on("end", () => resolvePromise());
    zip.readEntry();
  });
  zip.close();
}

function openZipBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) {
        rejectPromise(error ?? new Error("failed to open skill package"));
        return;
      }
      resolvePromise(zip);
    });
  });
}

function openZipEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        rejectPromise(error ?? new Error("failed to read skill package entry"));
        return;
      }
      resolvePromise(stream);
    });
  });
}

/** 定位技能目录：zip 根直接是技能（含 SKILL.md）或恰好一个子目录含 SKILL.md。 */
async function locateSkillDirectory(extractRoot: string): Promise<string> {
  if (existsSync(join(extractRoot, SKILL_FILE_NAME))) {
    return extractRoot;
  }
  const candidates: string[] = [];
  const entries = await readdir(extractRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractRoot, entry.name);
    if (existsSync(join(candidate, SKILL_FILE_NAME))) {
      candidates.push(candidate);
    }
  }
  if (candidates.length !== 1) {
    throw new SkillMarketPackageError(
      candidates.length === 0
        ? "skill package has no SKILL.md"
        : "skill package has multiple skill directories",
    );
  }
  return candidates[0]!;
}
