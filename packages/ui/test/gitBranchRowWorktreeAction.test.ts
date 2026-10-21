// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useEffect, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitLocalBranch, GitWorktreeMutationResult } from "@zcode/shared";

const mocks = vi.hoisted(() => ({
  addWorktree: vi.fn(),
  getLocalBranches: vi.fn(),
  addTab: vi.fn(),
  startDraft: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    FolderGit2: createIcon("folder-git2"),
    GitBranchIcon: createIcon("git-branch"),
    Trash2Icon: createIcon("trash2"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, onClick, ...props }: Record<string, unknown> & { children?: unknown }) =>
    createElement("button", { ...props, onClick }, children),
}));

vi.mock("@/components/ui/command.js", () => ({
  CommandItem: ({ onSelect, ...props }: Record<string, unknown> & { onSelect?: () => void }) =>
    // 与真实 cmdk Item 对齐：点击行触发 onSelect，用于验证行内动作的 stopPropagation 守卫。
    createElement("div", { ...props, onClick: onSelect }),
}));

vi.mock("@/git-branch-switcher/GitBranchConversationAction.js", () => ({
  GitBranchConversationAction: () => null,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values?.branchName != null ? `${id}:${values.branchName}` : id,
    },
  }),
}));

vi.mock("@/lib/pickerFocus.js", () => ({
  isCoarseTouchDevice: () => false,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    gitService: { addWorktree: mocks.addWorktree, getLocalBranches: mocks.getLocalBranches },
  }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => ({ getState: () => ({ addTab: mocks.addTab }) }),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: { getState: () => ({ startDraft: mocks.startDraft }) },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createBranch(overrides: Partial<GitLocalBranch>): GitLocalBranch {
  return {
    name: "feature/todo",
    isCurrent: false,
    upstreamName: null,
    commitHash: null,
    commitTimestampMs: null,
    worktreePath: null,
    ...overrides,
  };
}

type RowProps = ComponentType<{
  branch: GitLocalBranch;
  isCurrent: boolean;
  currentDirtyLabel: string | null;
  mutationPending: boolean;
  onSwitch: (branchName: string) => void;
  enableConversationAction: boolean;
  conversationPromptScope: { workspacePath: string };
  onConversationActionTriggered: () => void;
  onCreateWorktree?: (branchName: string) => void;
}>;

async function loadRowComponent(): Promise<RowProps> {
  const mod = await import("@/git-branch-switcher/GitBranchListRow.js");
  return mod.GitBranchListRow as RowProps;
}

describe("GitBranchListRow 新建 Worktree 动作", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("未被任何工作树检出的分支 hover 后浮现入口，点击创建且不触发分支切换", async () => {
    const GitBranchListRow = await loadRowComponent();
    const onSwitch = vi.fn();
    const onCreateWorktree = vi.fn();
    const { container } = render(
      createElement(GitBranchListRow, {
        branch: createBranch({ name: "feature/todo", worktreePath: null }),
        isCurrent: false,
        currentDirtyLabel: null,
        mutationPending: false,
        onSwitch,
        enableConversationAction: false,
        conversationPromptScope: { workspacePath: "/repo" },
        onConversationActionTriggered: () => {},
        onCreateWorktree,
      }),
    );

    // 未交互时不渲染，保持列表干净——与删除动作同模式。
    expect(
      screen.queryByRole("button", {
        name: "git.branchSwitcher.createWorktreeAction.ariaLabel:feature/todo",
      }),
    ).toBeNull();

    fireEvent.mouseEnter(container.firstElementChild as Element);

    const button = screen.getByRole("button", {
      name: "git.branchSwitcher.createWorktreeAction.ariaLabel:feature/todo",
    });
    // 行容器 items-start，行尾图标按钮统一用 -mt-0.5 贴齐首行文本（与删除/对话动作同款）；
    // 曾缺失导致「检出为 Worktree」按钮比相邻按钮低 2px。
    expect(button.className).toContain("-mt-0.5");
    fireEvent.click(button);

    expect(onCreateWorktree).toHaveBeenCalledWith("feature/todo");
    // 行内动作不冒泡成“切换到该分支”。
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("已被 worktree 检出或当前检出的分支不提供入口", async () => {
    const GitBranchListRow = await loadRowComponent();
    const onCreateWorktree = vi.fn();
    const baseProps = {
      currentDirtyLabel: null,
      mutationPending: false,
      onSwitch: vi.fn(),
      enableConversationAction: false,
      conversationPromptScope: { workspacePath: "/repo" },
      onConversationActionTriggered: () => {},
      onCreateWorktree,
    };

    const { container: worktreeContainer } = render(
      createElement(GitBranchListRow, {
        ...baseProps,
        branch: createBranch({ name: "feature/todo", worktreePath: "/repo/.worktrees/todo" }),
        isCurrent: false,
      }),
    );
    fireEvent.mouseEnter(worktreeContainer.firstElementChild as Element);

    const { container: currentContainer } = render(
      createElement(GitBranchListRow, {
        ...baseProps,
        branch: createBranch({ name: "main", worktreePath: null }),
        isCurrent: true,
      }),
    );
    fireEvent.mouseEnter(currentContainer.firstElementChild as Element);

    expect(screen.queryByRole("button", { name: /createWorktreeAction\.ariaLabel/ })).toBeNull();
    expect(onCreateWorktree).not.toHaveBeenCalled();
  });
});

describe("useGitWorktreeActions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function renderWorktreeActionsHarness(): Promise<{
    createWorktreeForBranch: (branchName: string) => Promise<void>;
    createWorktreeForProject: () => Promise<void>;
  }> {
    const { useGitWorktreeActions } =
      await import("@/git-branch-switcher/useGitWorktreeActions.js");
    let captured: {
      createWorktreeForBranch: (branchName: string) => Promise<void>;
      createWorktreeForProject: () => Promise<void>;
    } | null = null;

    function Harness() {
      const actions = useGitWorktreeActions({ workspacePath: "/repo" });
      useEffect(() => {
        captured = {
          createWorktreeForBranch: actions.createWorktreeForBranch,
          createWorktreeForProject: actions.createWorktreeForProject,
        };
      });
      return null;
    }

    render(createElement(Harness));
    // testing-library 的 render 自带 act，effect 已执行完毕。
    if (!captured) {
      throw new Error("useGitWorktreeActions 返回值未被捕获");
    }
    return captured;
  }

  it("createWorktreeForBranch：以既有分支请求 addWorktree，成功后 toast 并作为独立项目打开", async () => {
    mocks.addWorktree.mockResolvedValue({
      ok: true,
      worktree: { path: "/repo/.worktrees/feature-todo", branchName: "feature/todo" },
      issues: [],
    } satisfies GitWorktreeMutationResult);

    const { createWorktreeForBranch } = await renderWorktreeActionsHarness();
    await act(async () => {
      await createWorktreeForBranch("feature/todo");
    });

    // 检出既有分支模式：不传 newBranchName，目录名由服务端按「目录名 = 净化分支名」派生。
    expect(mocks.addWorktree).toHaveBeenCalledWith({
      workspacePath: "/repo",
      branchName: "feature/todo",
    });
    expect(mocks.toast).toHaveBeenCalledWith("git.worktree.toast.created");
    expect(mocks.addTab).toHaveBeenCalledWith("/repo/.worktrees/feature-todo");
    expect(mocks.startDraft).toHaveBeenCalledWith("/repo/.worktrees/feature-todo");
  });

  it("createWorktreeForBranch：创建被阻塞时不打开新项目，按 issue 码提示", async () => {
    mocks.addWorktree.mockResolvedValue({
      ok: false,
      worktree: null,
      issues: [{ code: "branch-in-other-worktree", message: "already checked out", detail: null }],
    } satisfies GitWorktreeMutationResult);

    const { createWorktreeForBranch } = await renderWorktreeActionsHarness();
    await act(async () => {
      await createWorktreeForBranch("feature/todo");
    });

    expect(mocks.addTab).not.toHaveBeenCalled();
    expect(mocks.startDraft).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("git.branchSwitcher.error.branchInOtherWorktree");
  });

  it("createWorktreeForProject：只传 newBranchName（feat/{随机数}），目录名交给服务端按分支名派生", async () => {
    mocks.getLocalBranches.mockResolvedValue({
      headRefType: "branch",
      currentBranchName: "main",
      branches: [],
      mainTreeRoot: "/repo",
    });
    mocks.addWorktree.mockResolvedValue({
      ok: true,
      worktree: { path: "/repo/.worktrees/feat-123456", branchName: "feat/123456" },
      issues: [],
    } satisfies GitWorktreeMutationResult);

    const { createWorktreeForProject } = await renderWorktreeActionsHarness();
    await act(async () => {
      await createWorktreeForProject();
    });

    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
    const request = mocks.addWorktree.mock.calls[0][0] as {
      workspacePath: string;
      newBranchName?: string;
      directoryName?: string;
    };
    expect(request.workspacePath).toBe("/repo");
    expect(request.newBranchName).toMatch(/^feat\/\d{6}$/);
    // 目录名不显式指定：服务端按「目录名 = 净化分支名」派生为 feat-{同后缀}。
    expect(request.directoryName).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith("git.worktree.toast.created");
    expect(mocks.addTab).toHaveBeenCalledWith("/repo/.worktrees/feat-123456");
  });
});
