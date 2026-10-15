// @vitest-environment jsdom
import { createContext, createElement, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TID_CHAT_CONTEXT_USAGE_COMPACT } from "@zcode/shared";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";

const contextOpenContext = createContext(false);

vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    createElement(contextOpenContext.Provider, { value: Boolean(open) }, children),
  ContextContent: ({ children }: { children?: ReactNode }) =>
    useContext(contextOpenContext) ? createElement("div", null, children) : null,
  ContextContentBody: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("div", props, children),
  ContextTrigger: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children ?? "context"),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntlOrDefault: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

// Root 的共享 TooltipProvider 不在单测挂载范围；这里只验证按钮行为，tooltip 渲染为透传容器。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: ReactNode }) =>
    createElement(
      "span",
      { "data-tooltip-title": typeof title === "string" ? title : "" },
      children,
    ),
}));

vi.mock("@/chat-input-toolbar/CodingPlanContextUsage.js", () => ({
  ChatCodingPlanUsageRemainingPanel: () => null,
  hasChatCodingPlanUsageRemaining: () => false,
}));

vi.mock("@/chat-input-toolbar/StartPlanContextBalance.js", () => ({
  ChatStartPlanBalancePanel: () => null,
  hasChatStartPlanBalance: () => false,
}));

function stubTouchDevice(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(hover: none)",
    media: query,
  }));
}

function renderContextUsage(overrides: Partial<Parameters<typeof ChatContextUsage>[0]> = {}): void {
  render(
    createElement(ChatContextUsage, {
      intl: {
        formatMessage: ({ id }: { id: string }) => id,
      } as never,
      locale: "en-US",
      selectedProvider: "glm",
      taskUsage: {
        used: 593_000,
        size: 1_000_000,
      },
      ...overrides,
    }),
  );
}

function openPanelViaTouch(): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: "chat.contextUsage" }), {
    pointerType: "touch",
  });
}

describe("ChatContextUsage compact button", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends /compact and closes the panel when the compress button is clicked", () => {
    stubTouchDevice();
    const onSendCompressionCommand = vi.fn();
    renderContextUsage({ onSendCompressionCommand });

    openPanelViaTouch();

    const compressButton = screen.getByTestId(TID_CHAT_CONTEXT_USAGE_COMPACT);
    expect(compressButton.disabled).toBe(false);
    fireEvent.click(compressButton);

    expect(onSendCompressionCommand).toHaveBeenCalledTimes(1);
    expect(onSendCompressionCommand).toHaveBeenCalledWith("/compact");
    // 面板随点击收起；压缩后的最新容量由 usage snapshot 推送回流，下次展开即新值。
    expect(screen.queryByText("chat.contextUsage.title")).toBeNull();
  });

  it("hides the compress button without a compression handler", () => {
    stubTouchDevice();
    renderContextUsage();

    openPanelViaTouch();

    expect(screen.getByText("chat.contextUsage.title")).toBeTruthy();
    expect(screen.queryByTestId(TID_CHAT_CONTEXT_USAGE_COMPACT)).toBeNull();
  });

  it("disables the compress button while a compact is running", () => {
    stubTouchDevice();
    const onSendCompressionCommand = vi.fn();
    renderContextUsage({ onSendCompressionCommand, compactRunning: true });

    openPanelViaTouch();

    const compressButton = screen.getByTestId(TID_CHAT_CONTEXT_USAGE_COMPACT);
    expect(compressButton.disabled).toBe(true);
    expect(compressButton.getAttribute("aria-label")).toBe("chat.contextUsage.compress");
    fireEvent.click(compressButton);

    expect(onSendCompressionCommand).not.toHaveBeenCalled();
  });

  it("disables the compress button while compression is disabled", () => {
    stubTouchDevice();
    const onSendCompressionCommand = vi.fn();
    renderContextUsage({ onSendCompressionCommand, compressionDisabled: true });

    openPanelViaTouch();

    expect(screen.getByTestId(TID_CHAT_CONTEXT_USAGE_COMPACT).disabled).toBe(true);
  });
});
