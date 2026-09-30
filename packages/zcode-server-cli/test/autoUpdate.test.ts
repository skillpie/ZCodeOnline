import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTO_UPDATE_DEFAULTS,
  DEFAULT_RELEASE_CATALOG_URL,
  resolveAutoUpdateSettings,
  shouldEnableAutoUpdateScheduler,
} from "../src/runtime/autoUpdateConfig.js";
import { readManagedInstall } from "../src/runtime/managedInstall.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { applyPreparedReleaseWithCleanup } from "../src/supervisor/autoUpdateApply.js";
import {
  AutoUpdateScheduler,
  type AutoUpdateCheckResult,
} from "../src/supervisor/autoUpdateScheduler.js";
import type { ReleaseManifest } from "../src/contracts.js";
import {
  mergeReleaseCatalogEntry,
  parseReleaseCatalog,
  upsertReleaseCatalogEntry,
} from "../src/packaging/releaseCatalog.js";

// 自动更新（specs/web-tunnel.md 更新器 M4）验收：
// 配置解析（默认开/kill switch/URL 覆盖/间隔收敛）/ 调度时序（空闲才应用、guard 保留
// pending、坏 release 条件清理、tick 不并发、stop 收口）/ catalog 合并（按 target 覆盖、
// 跨 target 保留、版本排序、损坏文件拒绝静默重建）。

function schedulerSettings() {
  return {
    enabled: true,
    catalogUrl: DEFAULT_RELEASE_CATALOG_URL,
    ...AUTO_UPDATE_DEFAULTS,
    initialDelayMs: 5,
    intervalMs: 5,
    maxJitterMs: 0,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), `timeout waiting for ${label}`);
}

test("resolveAutoUpdateSettings：默认启用并指向官方 catalog，kill switch 与 URL/间隔覆盖生效", () => {
  const defaults = resolveAutoUpdateSettings({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.catalogUrl, DEFAULT_RELEASE_CATALOG_URL);
  assert.equal(defaults.initialDelayMs, AUTO_UPDATE_DEFAULTS.initialDelayMs);

  for (const value of ["0", "false", "off", "no"]) {
    assert.equal(
      resolveAutoUpdateSettings({ ZCODE_SERVER_AUTO_UPDATE: value }).enabled,
      false,
      `ZCODE_SERVER_AUTO_UPDATE=${value} should disable`,
    );
  }
  assert.equal(resolveAutoUpdateSettings({ ZCODE_SERVER_AUTO_UPDATE: "1" }).enabled, true);

  assert.equal(
    resolveAutoUpdateSettings({
      ZCODE_SERVER_RELEASE_MANIFEST_URL: "https://example.test/cat.json",
    }).catalogUrl,
    "https://example.test/cat.json",
  );
  assert.equal(
    resolveAutoUpdateSettings({ ZCODE_SERVER_RELEASE_MANIFEST_URL: "  " }).catalogUrl,
    DEFAULT_RELEASE_CATALOG_URL,
  );

  assert.equal(
    resolveAutoUpdateSettings({ ZCODE_SERVER_AUTO_UPDATE_INTERVAL_MS: "1000" }).intervalMs,
    60_000,
    "interval below floor clamps to 1 minute",
  );
  assert.equal(
    resolveAutoUpdateSettings({ ZCODE_SERVER_AUTO_UPDATE_INTERVAL_MS: "bogus" }).intervalMs,
    AUTO_UPDATE_DEFAULTS.intervalMs,
  );
});

type SchedulerHarness = {
  checks: number;
  applies: number;
  checkResult: AutoUpdateCheckResult;
  checkError: Error | null;
  applyError: Error | null;
  canApply: boolean;
  releaseCheckGate: ((value: void) => void) | null;
};

function createHarness(overrides: Partial<SchedulerHarness> = {}) {
  const harness: SchedulerHarness = {
    checks: 0,
    applies: 0,
    checkResult: { status: "up-to-date", version: "1.0.0" },
    checkError: null,
    applyError: null,
    canApply: true,
    releaseCheckGate: null,
    ...overrides,
  };
  const scheduler = new AutoUpdateScheduler({
    settings: schedulerSettings(),
    random: () => 0,
    check: async () => {
      harness.checks += 1;
      if (harness.releaseCheckGate) {
        await new Promise<void>((resolve) => {
          harness.releaseCheckGate = resolve;
        });
      }
      if (harness.checkError) throw harness.checkError;
      return harness.checkResult;
    },
    canApply: () => harness.canApply,
    apply: async () => {
      harness.applies += 1;
      if (harness.applyError) throw harness.applyError;
    },
  });
  return { harness, scheduler };
}

test("调度：up-to-date 不应用；prepared 且空闲时应用一次，之后不再重复应用", async () => {
  const { harness, scheduler } = createHarness();
  scheduler.start();
  await waitFor(() => harness.checks === 1, "first check");
  assert.equal(harness.applies, 0, "up-to-date must not apply");

  harness.checkResult = { status: "prepared", version: "1.1.0" };
  await waitFor(() => harness.checks === 2, "second check");
  await waitFor(() => harness.applies === 1, "apply prepared release");

  harness.checkResult = { status: "up-to-date", version: "1.1.0" };
  await waitFor(() => harness.checks === 3, "third check");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.applies, 1, "no re-apply after applied");
  scheduler.stop();
});

test("调度：任务运行中只准备不应用，空闲后的下个 tick 再应用", async () => {
  const { harness, scheduler } = createHarness({
    checkResult: { status: "prepared", version: "1.1.0" },
  });
  harness.canApply = false;
  scheduler.start();
  await waitFor(() => harness.checks >= 2, "checks while busy");
  assert.equal(harness.applies, 0, "must defer apply while busy");

  harness.canApply = true;
  await waitFor(() => harness.applies === 1, "apply once idle");
  scheduler.stop();
});

test("调度：running-task 守卫拒绝时保留 pending 等待重试；其他失败也要继续排程", async () => {
  const guardError = new Error("Running tasks require --force for update");
  const { harness, scheduler } = createHarness({
    checkResult: { status: "prepared", version: "1.1.0" },
    applyError: guardError,
  });
  scheduler.start();
  await waitFor(() => harness.applies === 1, "first apply attempt");

  // 守卫失败不算终态：下一个 tick 仍会再次尝试应用。
  await waitFor(() => harness.applies >= 2, "retry after guard rejection");
  scheduler.stop();

  const fatal = createHarness({
    checkResult: { status: "prepared", version: "1.1.0" },
    applyError: new Error("new release failed to become ready"),
  });
  fatal.scheduler.start();
  await waitFor(() => fatal.harness.applies >= 1, "apply attempt on fatal path");
  await waitFor(() => fatal.harness.checks >= 2, "scheduler still scheduled after failure");
  fatal.scheduler.stop();
});

test("调度：check 慢时定时到达不并发进入 tick；stop 后不再检查", async () => {
  const { harness, scheduler } = createHarness({
    checkResult: { status: "up-to-date", version: "1.0.0" },
  });
  harness.releaseCheckGate = () => {};
  scheduler.start();
  await waitFor(() => harness.checks === 1, "first check started");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.checks, 1, "overlapping timer fire must be skipped");

  scheduler.stop();
  harness.releaseCheckGate?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const checksAfterStop = harness.checks;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.checks, checksAfterStop, "no further checks after stop");
});

function releaseManifest(version: string): ReleaseManifest {
  return {
    version,
    releaseDir: `/tmp/releases/${version}`,
    target: "darwin-arm64",
    archiveSha256: `a`.repeat(64),
  };
}

test("应用清理：running-task 守卫与回滚失败保留 pending，其他失败按版本条件清理", async () => {
  const guardDeps = {
    readPending: async () => releaseManifest("1.1.0"),
    removePending: async () => {
      throw new Error("removePending must not be called for guard rejection");
    },
    apply: async () => {
      throw new Error("Running tasks require --force for update");
    },
  };
  await assert.rejects(() => applyPreparedReleaseWithCleanup(guardDeps), /--force for update/);

  const rollbackDeps = {
    readPending: async () => releaseManifest("1.1.0"),
    removePending: async () => {
      throw new Error("removePending must not be called when rollback itself failed");
    },
    apply: async () => {
      throw new Error("Update failed: core not ready; rollback pointer restore failed: disk error");
    },
  };
  await assert.rejects(() => applyPreparedReleaseWithCleanup(rollbackDeps), /rollback pointer/);

  let removed = 0;
  const failingDeps = {
    readPending: async () => (removed ? null : releaseManifest("1.1.0")),
    removePending: async () => {
      removed += 1;
    },
    apply: async () => {
      throw new Error("new release failed to become ready");
    },
  };
  await assert.rejects(
    () => applyPreparedReleaseWithCleanup(failingDeps),
    /failed to become ready/,
  );
  assert.equal(removed, 1, "stale pending of the failed attempt must be removed");

  let removedForConcurrent = 0;
  const concurrentDeps = {
    readPending: async () =>
      removedForConcurrent ? releaseManifest("1.2.0") : releaseManifest("1.1.0"),
    removePending: async () => {
      removedForConcurrent += 1;
    },
    apply: async () => {
      throw new Error("new release failed to become ready");
    },
  };
  await assert.rejects(() => applyPreparedReleaseWithCleanup(concurrentDeps));
  assert.equal(
    removedForConcurrent,
    1,
    "pending rewritten by a concurrent manual update must be kept",
  );
});

const SHA = "a".repeat(64);

function catalogEntry(target: string, version: string) {
  return {
    version,
    target,
    archiveUrl: `https://example.test/dl/zcode-server-${target}.tar.gz`,
    archiveSha256: SHA,
    archiveSizeBytes: 1024,
  };
}

test("catalog 合并：按 target 覆盖、跨 target 保留、版本升序稳定排序", () => {
  const empty = parseReleaseCatalog(JSON.stringify({ schemaVersion: 1, releases: [] }));
  const withLinux = mergeReleaseCatalogEntry(empty, catalogEntry("linux-x64", "3.14.3"));
  const withDarwin = mergeReleaseCatalogEntry(withLinux, catalogEntry("darwin-arm64", "3.15.0"));
  assert.equal(withDarwin.releases.length, 2);

  const updated = mergeReleaseCatalogEntry(withDarwin, catalogEntry("linux-x64", "3.16.0-beta.1"));
  assert.equal(updated.releases.length, 2, "same target entry must be replaced");
  assert.deepEqual(
    updated.releases.map((release) => `${release.target}@${release.version}`),
    ["darwin-arm64@3.15.0", "linux-x64@3.16.0-beta.1"],
    "entries sorted by version regardless of merge order",
  );
});

test("catalog 落盘：不存在则创建，损坏文件报错而非静默重建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-catalog-"));
  try {
    const catalogFile = join(dir, "nested", "catalog.json");
    await upsertReleaseCatalogEntry(catalogFile, catalogEntry("linux-x64", "3.14.3"));
    let parsed = parseReleaseCatalog(await readFile(catalogFile, "utf8"));
    assert.equal(parsed.releases.length, 1);

    await upsertReleaseCatalogEntry(catalogFile, catalogEntry("darwin-arm64", "3.15.0"));
    parsed = parseReleaseCatalog(await readFile(catalogFile, "utf8"));
    assert.equal(parsed.releases.length, 2);

    await writeFile(catalogFile, "{ not json", "utf8");
    await assert.rejects(
      () => upsertReleaseCatalogEntry(catalogFile, catalogEntry("linux-x64", "3.16.0")),
      /invalid/,
    );

    await assert.rejects(
      () =>
        upsertReleaseCatalogEntry(join(dir, "bad.json"), {
          ...catalogEntry("linux-x64", "3.16.0"),
          archiveSha256: "not-a-hash",
        }),
      /failed|invalid|Expected/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("调度器启用判定：开关 + 布局（发行/受管安装）组合，dev 直跑不启用", () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    // [enabled, hasActiveRelease, hasManagedInstall, expected]
    [true, true, false, true],
    [true, false, true, true],
    [true, true, true, true],
    [true, false, false, false], // dev 直跑：两种布局标记皆无
    [false, true, true, false], // 显式关闭
  ];
  for (const [enabled, hasActiveRelease, hasManagedInstall, expected] of cases) {
    assert.equal(
      shouldEnableAutoUpdateScheduler({ enabled, hasActiveRelease, hasManagedInstall }),
      expected,
      `enabled=${enabled} release=${hasActiveRelease} managed=${hasManagedInstall}`,
    );
  }
});

test("受管安装标记：合法内容启用；缺失/损坏/字段不符 fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-managed-install-"));
  try {
    const layout = resolveServerLayout(dir);
    assert.equal(await readManagedInstall(layout), false, "缺失标记 = 非受管安装");

    const marker = join(dir, "managed-install.json");
    await writeFile(
      marker,
      '{"product":"zcode-server","managed":true,"installedAt":1790000000}\n',
      "utf8",
    );
    assert.equal(await readManagedInstall(layout), true);

    await writeFile(marker, "{ not json", "utf8");
    assert.equal(await readManagedInstall(layout), false, "损坏 JSON fail closed");

    await writeFile(
      marker,
      '{"product":"zcode-server","managed":false,"installedAt":1790000000}\n',
      "utf8",
    );
    assert.equal(await readManagedInstall(layout), false, "managed:false 不算受管安装");

    await writeFile(
      marker,
      '{"product":"zcode-server","managed":true,"installedAt":1790000000,"extra":1}\n',
      "utf8",
    );
    assert.equal(await readManagedInstall(layout), false, "未知字段 fail closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
