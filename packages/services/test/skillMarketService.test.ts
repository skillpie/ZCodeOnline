import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ZipFile } from "yazl";
import {
  createSkillMarketService,
  resolveSkillMarketBaseUrl,
} from "../src/skill-market/skillMarketService.js";
import { SkillMarketPackageError } from "../src/skill-market/skillMarketInstall.js";

// SkillPie 技能市场服务验收（specs/skill-market.md §5）：
// 搜索参数与字段宽松映射、详情相对地址补全、zip 安装/同名跳过/缺 SKILL.md 拒绝、付费技能拒绝直装。

const MARKET_BASE = "https://skillpie.example.test/";

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function buildSkillZip(entries: Array<{ path: string; content: string }>): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content, "utf-8"), entry.path);
  }
  zip.end();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  return done;
}

const SEARCH_PAYLOAD = {
  skills: [
    {
      id: "sk_1",
      name: "Redis操作",
      normalizedName: "redis",
      category: "开发工具",
      description: "Redis 操作工具。",
      ownerDisplayName: "鹿Sir",
      downloadCount: 481,
      likeCount: 120,
      isFree: true,
      version: { versionNo: 4 },
    },
    {
      id: "sk_2",
      name: "付费技能",
      normalizedName: "paid-skill",
      description: "需要购买。",
      // 缺 category/owner/download 等字段 → 宽松兜底
      isFree: false,
    },
  ],
};

const DETAIL_PAYLOAD: { skill: Record<string, unknown> } = {
  skill: {
    id: "sk_1",
    name: "Redis操作",
    normalizedName: "redis",
    category: "开发工具",
    description: "Redis 操作工具。",
    ownerDisplayName: "鹿Sir",
    downloadCount: 481,
    likeCount: 120,
    isFree: true,
    usageInstructions: "# 用法\n\n$redis get key",
    screenshots: null,
    version: {
      versionNo: 4,
      packageDownloadUrl: "/api/uploads/skills/pkg.zip",
      packageSize: 128,
    },
  },
};

let userSkillRoot = "";
const downloadedUrls: string[] = [];

function createFetch() {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/skills?")) {
      return jsonResponse(SEARCH_PAYLOAD);
    }
    if (url.includes("/api/skills/by-normalized-name/paid-skill")) {
      return jsonResponse({ skill: { ...DETAIL_PAYLOAD.skill, isFree: false } });
    }
    if (url.includes("/api/skills/by-normalized-name/redis")) {
      if (url.endsWith("/download-url")) {
        return jsonResponse({ downloadUrl: "/api/uploads/skills/pkg.zip" });
      }
      return jsonResponse(DETAIL_PAYLOAD);
    }
    if (url.endsWith("pkg.zip")) {
      downloadedUrls.push(url);
      const archive = await buildSkillZip([
        { path: "redis/SKILL.md", content: "---\nname: redis\ndescription: test\n---\n\nbody" },
      ]);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
        arrayBuffer: async () =>
          archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
      };
    }
    return jsonResponse({ message: "not found" }, 404);
  }) as unknown as typeof fetch;
}

function createService() {
  return createSkillMarketService({
    userSkillRoot,
    baseUrl: MARKET_BASE,
    fetchImpl: createFetch(),
  });
}

before(async () => {
  userSkillRoot = await mkdtemp(join(tmpdir(), "zcode-skill-market-test-"));
});

after(async () => {
  await rm(userSkillRoot, { recursive: true, force: true });
});

test("baseUrl defaults to online skillpie and honors env override", () => {
  assert.equal(resolveSkillMarketBaseUrl(), "https://skillpie.cn/");
  assert.equal(
    resolveSkillMarketBaseUrl({ ZCODE_SKILL_MARKET_URL: "http://localhost:3001/" }),
    "http://localhost:3001/",
  );
});

test("searchSkills hits search api and maps fields leniently", async () => {
  const service = createService();
  const results = await service.searchSkills({ query: "redis" });
  assert.equal(results.length, 2);
  assert.equal(results[0]!.normalizedName, "redis");
  assert.equal(results[0]!.versionNo, 4);
  assert.equal(results[0]!.isFree, true);
  // 缺失字段兜底，不抛错
  assert.equal(results[1]!.downloadCount, 0);
  assert.equal(results[1]!.category, null);
  assert.equal(results[1]!.isFree, false);
});

test("searchSkills returns empty without request for blank query", async () => {
  const service = createService();
  assert.deepEqual(await service.searchSkills({ query: "   " }), []);
});

test("getSkillDetail resolves relative urls and null screenshots", async () => {
  const service = createService();
  const detail = await service.getSkillDetail({ normalizedName: "redis" });
  assert.equal(detail.usageInstructions, "# 用法\n\n$redis get key");
  assert.deepEqual(detail.screenshots, []);
  assert.equal(
    detail.version?.packageDownloadUrl,
    `${MARKET_BASE.replace(/\/+$/u, "")}/api/uploads/skills/pkg.zip`,
  );
  assert.equal(detail.version?.versionNo, 4);
});

test("installSkill downloads package and installs into user skill root", async () => {
  const service = createService();
  const result = await service.installSkill({ normalizedName: "redis" });
  assert.equal(result.status, "installed");
  assert.equal(result.versionNo, 4);
  assert.match(
    downloadedUrls[0]!,
    /^https:\/\/skillpie\.example\.test\/api\/uploads\/skills\/pkg\.zip$/u,
  );
  const installed = join(userSkillRoot, "redis", "SKILL.md");
  await stat(installed);
  assert.match(await readFile(installed, "utf-8"), /name: redis/u);
});

test("installSkill reports already-installed without touching existing directory", async () => {
  const service = createService();
  const result = await service.installSkill({ normalizedName: "redis" });
  assert.equal(result.status, "already-installed");
  assert.equal(downloadedUrls.length, 1);
});

test("installSkill rejects paid skills before downloading", async () => {
  const service = createService();
  await assert.rejects(service.installSkill({ normalizedName: "paid-skill" }), /paid skills/u);
});

test("installSkill rejects packages without SKILL.md", async () => {
  const paidDetail = { ...DETAIL_PAYLOAD.skill } as Record<string, unknown>;
  const service = createSkillMarketService({
    userSkillRoot,
    baseUrl: MARKET_BASE,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/skills/by-normalized-name/no-skill-md")) {
        return jsonResponse({
          skill: { ...paidDetail, normalizedName: "no-skill-md", name: "NoSkillMd" },
        });
      }
      const archive = await buildSkillZip([{ path: "readme.txt", content: "not a skill" }]);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
      };
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    service.installSkill({ normalizedName: "no-skill-md" }),
    SkillMarketPackageError,
  );
});

test("installSkill rejects path-like normalized names", async () => {
  const service = createService();
  await assert.rejects(service.installSkill({ normalizedName: "../escape" }), /unsafe/u);
});
