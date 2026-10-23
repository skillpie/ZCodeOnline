// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { GitPaneChangeCard } from "@/GitPaneChangeCard.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("@/hooks/useGitBlame.js", () => ({
  useGitBlameLineResolver: () => () => undefined,
}));
vi.mock("@/components/ui/diff-viewer.js", () => ({
  DiffViewer: () => null,
}));
vi.mock("@/components/ui/lightweight-diff-preview.js", () => ({
  LightweightDiffPreview: () => null,
}));
vi.mock("@/components/ui/context-menu.js", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  // asChild 由 Radix 处理；测试里直接渲染触发器内容即可覆盖行按钮的点击门控。
  ContextMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
}));

const baseChange: GitPaneFileChange = {
  path: "/repo/asset.bin",
  repoRelativePath: "asset.bin",
  workspaceRelativePath: "asset.bin",
  kind: "added",
  section: "untracked",
  added: 0,
  removed: 0,
  isStaged: false,
  isUntracked: true,
  isConflicted: false,
  isReviewable: false,
  diff: null,
};

const contextMenuLabels = {
  copyAbsolutePath: "copyAbsolutePath",
  copyRelativePath: "copyRelativePath",
  revealInFileManager: "revealInFileManager",
  revealInFileTree: "revealInFileTree",
  discard: "discard",
};

function renderCard(
  change: GitPaneFileChange,
  onOpenChange: (change: GitPaneFileChange, nextOpen: boolean) => void,
) {
  return render(
    createElement(GitPaneChangeCard, {
      change,
      contextMenuLabels,
      diffState: null,
      isDiffLoading: false,
      isExpanded: false,
      canRevealInFileManager: true,
      codePreviewSettings: { fontSizePx: 12, lightTheme: "light", darkTheme: "dark" },
      resolvedTheme: "light",
      onCopyAbsolutePath: vi.fn(),
      onCopyRelativePath: vi.fn(),
      onOpenChange,
      onRevealInFileManager: vi.fn(),
    }),
  );
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("GitPaneChangeCard", () => {
  it("expands reviewable changes on click", () => {
    const onOpenChange = vi.fn();
    const { getByRole } = renderCard({ ...baseChange, isReviewable: true, added: 3 }, onOpenChange);

    fireEvent.click(getByRole("button", { name: /asset\.bin/ }));
    expect(onOpenChange).toHaveBeenCalledWith(
      expect.objectContaining({ path: baseChange.path }),
      true,
    );
  });

  it("renders non-reviewable changes as read-only rows without expand affordance", () => {
    // 口径对齐（fengqun-scm）：零行数未跟踪条目进列表展示，但没有可审查 diff，
    // 整行不可点击展开、不声明 aria-expanded，避免用户点了之后只看到空态。
    const onOpenChange = vi.fn();
    const { getByRole } = renderCard(baseChange, onOpenChange);

    const row = getByRole("button", { name: /asset\.bin/ });
    expect(row.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(row);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
