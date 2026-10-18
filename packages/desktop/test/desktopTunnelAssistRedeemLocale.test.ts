// 远程码兑换错误文案的语言必须跟随宿主系统首选语言（resolveSystemApplicationLocale），
// 不能用 navigator.language 判定——macOS 中文系统下它可能是 en-US，导致控制端门禁
// 弹出英文错误（用户可见回归）。这里直接捕获 IPC handler 验证 message 语言。
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleMock = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => ({
  locale: "en-US",
  preferredSystemLanguages: [] as string[],
}));

vi.mock("electron", () => ({
  app: {
    getLocale: vi.fn(() => envMock.locale),
    getPreferredSystemLanguages: vi.fn(() => envMock.preferredSystemLanguages),
  },
  ipcMain: {
    handle: handleMock,
  },
}));

// 兑换链路只经 relay HTTP fetch；daemon 控制链不在本用例范围，mock 掉避免拉起重依赖。
vi.mock("@zcode/server-cli/control", () => ({
  requestControl: vi.fn(),
  resolveServerLayout: vi.fn(() => ({ controlEndpoint: "" })),
  ControlRequestError: class ControlRequestError extends Error {},
}));

import { PlatformChannels, type RedeemAssistCodeResult } from "@zcode/shared";

type RedeemHandler = (_event: unknown, code: string) => Promise<RedeemAssistCodeResult>;

// 被测模块延后到用例内动态加载：electron 的 ipcMain.handle mock 须先于模块初始化完成捕获。
async function getRedeemHandler(): Promise<RedeemHandler> {
  const { registerTunnelControlIpcHandlers } = await import("../src/main/desktopTunnelControl.js");
  handleMock.mockClear();
  registerTunnelControlIpcHandlers();
  const entry = handleMock.mock.calls.find(
    ([channel]) => channel === PlatformChannels.RedeemAssistCode,
  );
  if (!entry) {
    throw new Error("RedeemAssistCode handler not registered");
  }
  return entry[1] as RedeemHandler;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("redeemAssistCodeViaRelay 错误文案语言", () => {
  it("系统首选语言为中文时返回中文错误（401 invalid）", async () => {
    envMock.locale = "en-US";
    envMock.preferredSystemLanguages = ["zh-Hans-CN", "en-CN"];
    const redeem = await getRedeemHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const result = await redeem({}, "1234567890123456");
    expect(result).toEqual({ ok: false, kind: "invalid", message: "远程码无效或已被刷新。" });
  });

  it("系统首选语言为英文时返回英文错误", async () => {
    envMock.locale = "en-US";
    envMock.preferredSystemLanguages = ["en-US"];
    const redeem = await getRedeemHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const result = await redeem({}, "1234567890123456");
    expect(result).toEqual({
      ok: false,
      kind: "invalid",
      message: "The assist code is invalid or has been rotated.",
    });
  });

  it("网络失败文案同样跟随系统语言", async () => {
    envMock.locale = "en-US";
    envMock.preferredSystemLanguages = ["zh-Hans-CN"];
    const redeem = await getRedeemHandler();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await redeem({}, "1234567890123456");
    expect(result).toEqual({
      ok: false,
      kind: "network",
      message: "无法连接 relay 服务，请检查网络后重试。",
    });
  });
});
