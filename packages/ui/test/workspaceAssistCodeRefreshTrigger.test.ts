// @vitest-environment jsdom

// WorkspaceAssistCodeRefreshTrigger 本机缺省名：已登录 ZCode 账号时用账号名
// （displayName 优先），未登录回退「我的ZCode」文案；存量「我的ZCode」条目在打开
// 弹窗（权威本机发现）时原位升级为账号名，用户改过名的不覆盖（store 语义见
// assistMachineStore.test.ts，这里验证组件把登录名传进了权威登记路径）。
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAssistCodeRefreshTrigger } from "@/WorkspaceAssistCodeRefreshTrigger.js";
import { loadAssistMachines } from "@/assistMachineStore.js";

const { getRemoteAssistCode } = vi.hoisted(() => ({
  // expiresAt 非 null = 权威回环发现，本机缺省名只走这条路径。
  getRemoteAssistCode: vi.fn(() =>
    Promise.resolve({ code: "12345678", expiresAt: 4102444800000 }),
  ),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getRemoteAssistCode,
    refreshRemoteAssistCode: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        id === "assistCode.dialog.localDefaultName" ? "我的ZCode" : id,
    },
  }),
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => async () => true,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) =>
    createElement("span", null, children),
}));

vi.mock("@/AssistMachineRowCard.js", () => ({
  AssistMachineRowCard: ({ machine }: { machine: { name: string } }) =>
    createElement("div", null, machine.name),
}));

vi.mock("@/AssistMachineAddDialog.js", () => ({
  AssistMachineAddDialog: () => null,
}));

vi.mock("@/BotChannelPanel.js", () => ({
  BotChannelPanel: () => null,
}));

type TriggerUser = { id: string; username: string; displayName: string };

function openTrigger(user?: TriggerUser) {
  render(
    createElement(WorkspaceAssistCodeRefreshTrigger, {
      isDesktop: false,
      botChannel: null,
      user: user ?? null,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "assistCode.dialog.trigger" }));
}

beforeEach(() => {
  localStorage.clear();
  getRemoteAssistCode.mockClear();
});

describe("WorkspaceAssistCodeRefreshTrigger 本机缺省名", () => {
  it("已登录：打开弹窗后本机条目缺省名为账号 displayName", async () => {
    openTrigger({ id: "u1", username: "jensen", displayName: "林春成" });
    await waitFor(() => {
      const [local] = loadAssistMachines();
      expect(local?.code).toBe("12345678");
      expect(local?.name).toBe("林春成");
      expect(local?.local).toBe(true);
    });
  });

  it("displayName 为空白时回退 username", async () => {
    openTrigger({ id: "u1", username: "jensen", displayName: "   " });
    await waitFor(() => expect(loadAssistMachines()[0]?.name).toBe("jensen"));
  });

  it("未登录：本机条目缺省名回退 i18n 文案「我的ZCode」", async () => {
    openTrigger();
    await waitFor(() => expect(loadAssistMachines()[0]?.name).toBe("我的ZCode"));
  });

  it("存量「我的ZCode」条目：打开弹窗后原位升级为账号名", async () => {
    localStorage.setItem(
      "zcode-assist-machines",
      JSON.stringify([{ code: "12345678", name: "我的ZCode", local: true }]),
    );
    openTrigger({ id: "u1", username: "jensen", displayName: "林春成" });
    await waitFor(() => {
      const [local] = loadAssistMachines();
      expect(local?.name).toBe("林春成");
      expect(loadAssistMachines()).toHaveLength(1);
    });
  });
});
