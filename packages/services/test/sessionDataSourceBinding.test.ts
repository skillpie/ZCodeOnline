// 会话级数据源绑定（宿主侧 session-bindings.json）的读写与清理语义。
// 覆盖：读写往返、清除、会话删除清理、平铺跨端共享（不按 workspace 分桶）、幂等、
// 并发写串行化、门控回退的悬挂验证、删源清理。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { saveDataSourceConfigFile } from "../src/data-source/dataSourceConfigFile.js";
import {
  deleteSessionDataSourceBinding,
  deleteSessionDataSourceBindingsForDataSource,
  readSessionDataSourceBinding,
  resolveVerifiedSessionDataSourceBinding,
  writeSessionDataSourceBinding,
} from "../src/data-source/sessionDataSourceBinding.js";

// 直接驱动宿主侧文件实现（渲染层薄封装只做服务转发，不重复覆盖）。
// 数据目录指到临时目录，不触碰真实 ~/.zcode。

let dataRoot: string;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "zcode-session-binding-test-"));
  setDataBaseDir(dataRoot);
});

afterAll(async () => {
  setDataBaseDir(null);
  await rm(dataRoot, { recursive: true, force: true });
});

describe("宿主侧会话数据源绑定文件", () => {
  it("写入后可读取；清除后读 null", async () => {
    await writeSessionDataSourceBinding("sess-1", "ds-1");
    expect(await readSessionDataSourceBinding("sess-1")).toBe("ds-1");
    await writeSessionDataSourceBinding("sess-1", null);
    expect(await readSessionDataSourceBinding("sess-1")).toBeNull();
  });

  it("会话删除清理绑定（幂等）", async () => {
    await writeSessionDataSourceBinding("sess-del", "ds-1");
    await deleteSessionDataSourceBinding("sess-del");
    expect(await readSessionDataSourceBinding("sess-del")).toBeNull();
    // 再次删除不抛错。
    await expect(deleteSessionDataSourceBinding("sess-del")).resolves.toBeUndefined();
  });

  it("多会话互不干扰；绑定按 sessionId 平铺，无 workspace 维度", async () => {
    await writeSessionDataSourceBinding("sess-a", "ds-1");
    await writeSessionDataSourceBinding("sess-b", "ds-2");
    expect(await readSessionDataSourceBinding("sess-a")).toBe("ds-1");
    expect(await readSessionDataSourceBinding("sess-b")).toBe("ds-2");
  });

  it("并发写串行化：同时写不同会话互不吞写", async () => {
    // 写入是读-改-写，无串行时两个并发写会后写覆盖前写（丢绑定）。
    await Promise.all([
      writeSessionDataSourceBinding("sess-race-1", "ds-1"),
      writeSessionDataSourceBinding("sess-race-2", "ds-2"),
      writeSessionDataSourceBinding("sess-race-3", "ds-3"),
    ]);
    expect(await readSessionDataSourceBinding("sess-race-1")).toBe("ds-1");
    expect(await readSessionDataSourceBinding("sess-race-2")).toBe("ds-2");
    expect(await readSessionDataSourceBinding("sess-race-3")).toBe("ds-3");
  });

  it("同值重复写幂等（信封自愈与 UI 双路径不互斥）", async () => {
    await writeSessionDataSourceBinding("sess-idem", "ds-1");
    await writeSessionDataSourceBinding("sess-idem", "ds-1");
    expect(await readSessionDataSourceBinding("sess-idem")).toBe("ds-1");
  });

  it("门控回退验证：绑定存在且数据源在配置中才返回", async () => {
    await saveDataSourceConfigFile({
      activeId: null,
      dataSources: [
        {
          id: "ds-live",
          type: "postgresql",
          name: "live",
          host: "localhost",
          port: 5432,
          user: "u",
          password: "p",
          database: "db",
          readOnly: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    await writeSessionDataSourceBinding("sess-verified", "ds-live");
    expect(await resolveVerifiedSessionDataSourceBinding("sess-verified")).toBe("ds-live");
    // 悬挂绑定（源已删除/从未存在）按未选择处理（specs/data-source.md §7.5 场景 4）。
    await writeSessionDataSourceBinding("sess-dangling", "ds-gone");
    expect(await resolveVerifiedSessionDataSourceBinding("sess-dangling")).toBeNull();
    expect(await resolveVerifiedSessionDataSourceBinding("sess-unbound")).toBeNull();
  });

  it("删除数据源时清理指向它的全部绑定，其他会话不受影响", async () => {
    await saveDataSourceConfigFile({
      activeId: null,
      dataSources: [
        {
          id: "ds-doomed",
          type: "postgresql",
          name: "doomed",
          host: "localhost",
          port: 5432,
          user: "u",
          password: "p",
          database: "db",
          readOnly: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    await writeSessionDataSourceBinding("sess-del-src-1", "ds-doomed");
    await writeSessionDataSourceBinding("sess-del-src-2", "ds-doomed");
    await writeSessionDataSourceBinding("sess-del-src-keep", "ds-1");
    await deleteSessionDataSourceBindingsForDataSource("ds-doomed");
    expect(await readSessionDataSourceBinding("sess-del-src-1")).toBeNull();
    expect(await readSessionDataSourceBinding("sess-del-src-2")).toBeNull();
    expect(await readSessionDataSourceBinding("sess-del-src-keep")).toBe("ds-1");
    // 幂等：无引用时 no-op。
    await expect(
      deleteSessionDataSourceBindingsForDataSource("ds-doomed"),
    ).resolves.toBeUndefined();
  });
});
