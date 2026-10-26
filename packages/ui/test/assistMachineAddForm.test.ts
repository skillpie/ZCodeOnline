// @vitest-environment jsdom

// 「添加远程链接」表单（specs/web-tunnel.md §5.9）：提交先经平台 redeemAssistCode
// 向 relay 预检（兑换只校验码、不消费），预检成功才回调入库；名称不在添加时设置。
// 码非法/重复在本地拦截，不发起预检；预检失败原样展示结构化应答的面向用户文案。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistMachineAddForm } from "@/AssistMachineAddForm.js";

const { redeemAssistCode, platformState } = vi.hoisted(() => ({
  redeemAssistCode: vi.fn(),
  // 平台契约缺省场景可切换：redeemAssistCode 在 IPlatformService 上是可选方法。
  platformState: { hasRedeem: true },
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => (platformState.hasRedeem ? { redeemAssistCode } : {}),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

type FormProps = Parameters<typeof AssistMachineAddForm>[0];

function renderForm(overrides?: Partial<FormProps>) {
  const props: FormProps = {
    localCode: null,
    existingCodes: [],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(createElement(AssistMachineAddForm, props));
  return props;
}

function fillCodeAndSubmit(code: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByText("assistCode.dialog.addConfirm"));
}

beforeEach(() => {
  redeemAssistCode.mockReset();
  platformState.hasRedeem = true;
});

// vitest globals 未开启时 testing-library 不自动清理，多用例会共享渲染树。
afterEach(cleanup);

describe("AssistMachineAddForm 预检入库", () => {
  it("码非法：本地拦截，不发起预检也不入库", async () => {
    const props = renderForm();
    fillCodeAndSubmit("not-a-code");
    await waitFor(() => expect(screen.getByText("assistCode.dialog.addInvalid")).toBeTruthy());
    expect(redeemAssistCode).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("码重复：本地拦截，不发起预检", async () => {
    renderForm({ existingCodes: ["12345678"] });
    fillCodeAndSubmit("https://zcode.skillpie.cn/12345678");
    await waitFor(() => expect(screen.getByText("assistCode.dialog.addDuplicate")).toBeTruthy());
    expect(redeemAssistCode).not.toHaveBeenCalled();
  });

  it("预检成功：以归一化 8 位码回调入库", async () => {
    const props = renderForm();
    redeemAssistCode.mockResolvedValue({
      ok: true,
      hostId: "h-1",
      connectToken: `tok-${"x".repeat(40)}`,
      psk: "psk",
    });
    fillCodeAndSubmit("https://zcode.skillpie.cn/12345678");
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith("12345678"));
    expect(redeemAssistCode).toHaveBeenCalledWith("12345678");
  });

  it("预检失败（码无效/已轮换）：展示结构化应答文案，不入库", async () => {
    const props = renderForm();
    redeemAssistCode.mockResolvedValue({
      ok: false,
      kind: "invalid",
      message: "远程码无效或已被刷新。",
    });
    fillCodeAndSubmit("12345678");
    await waitFor(() => expect(screen.getByText("远程码无效或已被刷新。")).toBeTruthy());
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("预检进行中：按钮进入校验中并禁用，防止并发提交", async () => {
    renderForm();
    let resolveRedeem: (value: unknown) => void = () => {};
    redeemAssistCode.mockReturnValue(
      new Promise((resolve) => {
        resolveRedeem = resolve;
      }),
    );
    fillCodeAndSubmit("12345678");
    const addButton = screen.getByText("assistCode.dialog.addVerifying");
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    resolveRedeem({
      ok: true,
      hostId: "h-1",
      connectToken: `tok-${"x".repeat(40)}`,
      psk: "psk",
    });
    await waitFor(() =>
      expect(screen.getByText("assistCode.dialog.addConfirm")).toBeTruthy(),
    );
  });

  it("平台未实现 redeemAssistCode：提示不可用，不入库", async () => {
    platformState.hasRedeem = false;
    const props = renderForm();
    fillCodeAndSubmit("12345678");
    await waitFor(() =>
      expect(screen.getByText("assistCode.dialog.addVerifyUnavailable")).toBeTruthy(),
    );
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
