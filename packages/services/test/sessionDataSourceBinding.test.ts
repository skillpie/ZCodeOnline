// 会话级数据源绑定（宿主侧 session-bindings.json）的读写与清理语义。
// 覆盖：读写往返、清除、会话删除清理、平铺跨端共享（不按 workspace 分桶）、幂等。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import {
  deleteSessionDataSourceBinding,
  readSessionDataSourceBinding,
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
});
