// specs/data-source.md §7 的工具侧验收：DB 工具缺省目标源优先取会话级绑定，
// 显式入参最优先，无绑定时保持全局 activeId fallback（§6 行为不变）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataSource } from "../../src/tool/handlers/db/store.js";

const ENV_KEY = "ZCODE_DATA_BASE_DIR";

interface SeedSource {
  id: string;
  name: string;
}

async function seedDataSources(sources: SeedSource[], activeId: string | null): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-db-store-"));
  const dir = join(baseDir, ".zcode", "v2", "data-sources");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      activeId,
      dataSources: sources.map((item) => ({
        createdAt: "2026-01-01T00:00:00.000Z",
        database: "db",
        host: "127.0.0.1",
        id: item.id,
        name: item.name,
        password: "",
        port: 3306,
        readOnly: true,
        type: "mysql",
        user: "root",
      })),
    }),
    "utf-8",
  );
  return baseDir;
}

test("缺省目标源优先解析会话级绑定的数据源", async () => {
  const baseDir = await seedDataSources(
    [
      { id: "ds-a", name: "订单库" },
      { id: "ds-b", name: "用户库" },
    ],
    "ds-b",
  );
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  try {
    // 会话绑定 ds-a，全局 active 是 ds-b → 缺省必须取 ds-a
    const source = await resolveDataSource(undefined, "ds-a");
    assert.equal(source.config.id, "ds-a");
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("显式 data_source 入参仍最优先", async () => {
  const baseDir = await seedDataSources(
    [
      { id: "ds-a", name: "订单库" },
      { id: "ds-b", name: "用户库" },
    ],
    "ds-a",
  );
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  try {
    const source = await resolveDataSource("用户库", "ds-a");
    assert.equal(source.config.id, "ds-b");
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("未选择会话数据源时保持 activeId fallback", async () => {
  const baseDir = await seedDataSources([{ id: "ds-b", name: "用户库" }], "ds-b");
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  try {
    const source = await resolveDataSource(undefined, undefined);
    assert.equal(source.config.id, "ds-b");
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("会话绑定的数据源已删除时按未配置报错，不静默回退 activeId", async () => {
  const baseDir = await seedDataSources(
    [
      { id: "ds-a", name: "订单库" },
      { id: "ds-b", name: "用户库" },
    ],
    "ds-b",
  );
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = baseDir;
  try {
    await assert.rejects(
      () => resolveDataSource(undefined, "ds-gone"),
      /no longer configured/,
    );
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});
