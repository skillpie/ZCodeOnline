// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";

describe("useProviderAvailabilityLoginEntryGuard", () => {
  it("首次 Selection 读取失败结束启动等待且不伪装成无 Provider", async () => {
    const setLoginEntryOpen = vi.fn();
    const { result } = renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        user: null,
        isStartupCheckDeferred: false,
        providerFamilyDomain: "zai",
        modelSelectionView: null,
        modelSelectionError: new Error("registry unavailable"),
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: vi.fn(),
        setLoginEntryOpen,
      }),
    );

    await waitFor(() => expect(result.current.startupCheckCompleted).toBe(true));
    expect(setLoginEntryOpen).not.toHaveBeenCalled();
  });

  it("等待 Selection View 水合后再判断启动可用性", async () => {
    const setLoginEntryOpen = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const view = {
      revision: 1,
      providers: [
        {
          providerId: "registry-provider",
          config: { kind: "api" as const },
          models: [{ modelId: "registry-model", config: {} }],
        },
      ],
    };
    const { rerender } = renderHook(
      (props: { hydrated: boolean }) =>
        useProviderAvailabilityLoginEntryGuard({
          user: null,
          isStartupCheckDeferred: false,
          providerFamilyDomain: "zai",
          modelSelectionView: props.hydrated ? view : null,
          refreshProviderState,
          readModelSelectionView: async () => view,
          setLoginEntryOpen,
        }),
      { initialProps: { hydrated: false } },
    );

    await Promise.resolve();
    expect(setLoginEntryOpen).not.toHaveBeenCalled();

    rerender({ hydrated: true });

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(false));
    expect(refreshProviderState).not.toHaveBeenCalled();
  });

  it("启动输入未落定时延后检查，落定后只执行一次", async () => {
    const setLoginEntryOpen = vi.fn();
    const view = {
      revision: 1,
      providers: [
        {
          providerId: "registry-provider",
          config: { kind: "api" as const },
          models: [{ modelId: "registry-model", config: {} }],
        },
      ],
    };
    const { rerender } = renderHook(
      (props: { deferred: boolean }) =>
        useProviderAvailabilityLoginEntryGuard({
          user: null,
          isStartupCheckDeferred: props.deferred,
          providerFamilyDomain: "zai",
          modelSelectionView: view,
          refreshProviderState: vi.fn(async () => {}),
          readModelSelectionView: async () => view,
          setLoginEntryOpen,
        }),
      { initialProps: { deferred: true } },
    );

    await Promise.resolve();
    expect(setLoginEntryOpen).not.toHaveBeenCalled();

    rerender({ deferred: false });

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledTimes(1));
    expect(setLoginEntryOpen).toHaveBeenCalledWith(false);

    // 检查是一次性判定：后续输入变化（如 user 落定）不得重复开关登录入口。
    rerender({ deferred: false });
    await Promise.resolve();
    expect(setLoginEntryOpen).toHaveBeenCalledTimes(1);
  });

  it("enabled=false 时立即结束启动等待且不执行检查", async () => {
    const setLoginEntryOpen = vi.fn();
    const { result } = renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        enabled: false,
        user: null,
        isStartupCheckDeferred: false,
        providerFamilyDomain: "zai",
        modelSelectionView: null,
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: vi.fn(),
        setLoginEntryOpen,
      }),
    );

    expect(result.current.startupCheckCompleted).toBe(true);
    await Promise.resolve();
    expect(setLoginEntryOpen).not.toHaveBeenCalled();
  });
});
