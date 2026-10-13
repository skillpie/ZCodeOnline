import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProviderStatusIndicator } from "@/settings/model-provider-section/ProviderStatusIndicator.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  // useZCodeIntlOrDefault 为本地 blame 无 Provider 回退路径新增的导出，mock 需同步提供。
  useZCodeIntlOrDefault: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
describe("Provider status presentation", () => {
  it.each([
    [false, true, "disabled"],
    [true, false, "unavailable"],
    [true, true, "ready"],
  ] as const)("enabled=%s executable=%s", (enabled, executable, status) => {
    const html = renderToStaticMarkup(
      createElement(ProviderStatusIndicator, { provider: { enabled, executable } }),
    );
    expect(html).toContain(`data-provider-status="${status}"`);
  });
});
