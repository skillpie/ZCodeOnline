// 会话级数据源绑定（宿主侧 session-bindings.json）的读写与清理语义。
// 覆盖：读写往返、清除、会话删除清理、workspace 隔离、多会话互不干扰、幂等。
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
    await writeSessionDataSourceBinding("/ws", undefined, "sess-1", "ds-1");
    expect(await readSessionDataSourceBinding("/ws", undefined, "sess-1")).toBe("ds-1");
    await writeSessionDataSourceBinding("/ws", undefined, "sess-1", null);
    expect(await readSessionDataSourceBinding("/ws", undefined, "sess-1")).toBeNull();
  });

  it("workspace 之间隔离（identity 优先于 path）", async () => {
    await writeSessionDataSourceBinding("/ws-a", "remote-1", "sess-1", "ds-a");
    await writeSessionDataSourceBinding("/ws-a", undefined, "sess-1", "ds-b");
    expect(await readSessionDataSourceBinding("/ws-a", "remote-1", "sess-1")).toBe("ds-a");
    expect(await readSessionDataSourceBinding("/ws-a", undefined, "sess-1")).toBe("ds-b");
    expect(await readSessionDataSourceBinding("/ws-b", undefined, "sess-1")).toBeNull();
  });

  it("会话删除清理绑定（幂等）", async () => {
    await writeSessionDataSourceBinding("/ws", undefined, "sess-del", "ds-1");
    await deleteSessionDataSourceBinding("/ws", undefined, "sess-del");
    expect(await readSessionDataSourceBinding("/ws", undefined, "sess-del")).toBeNull();
    // 再次删除不抛错。
    await expect(
      deleteSessionDataSourceBinding("/ws", undefined, "sess-del"),
    ).resolves.toBeUndefined();
  });

  it("同 workspace 多会话互不干扰", async () => {
    await writeSessionDataSourceBinding("/ws", undefined, "sess-1", "ds-1");
    await writeSessionDataSourceBinding("/ws", undefined, "sess-2", "ds-2");
    expect(await readSessionDataSourceBinding("/ws", undefined, "sess-1")).toBe("ds-1");
    expect(await readSessionDataSourceBinding("/ws", undefined, "sess-2")).toBe("ds-2");
  });
});
