import { describe, expect, it, vi } from "vitest";
import type { GitDiffResult, GitFileChange, ZCodeWorkspaceGenerateTextParams } from "@zcode/shared";

type ZCodeSelection = ZCodeWorkspaceGenerateTextParams["selection"];
import {
  GitCommitMessageGenerationError,
  GitCommitMessageGenerator,
} from "../src/git/gitCommitMessageGenerator.js";

const DEFAULT_SELECTION: ZCodeSelection = {
  providerId: "openai-compatible",
  modelId: "test-model",
};

function createTextGenerator(responseText: string) {
  return {
    generateText: vi.fn(async (params: { selection: ZCodeSelection }) => ({
      text: responseText,
      selection: params.selection,
    })),
  };
}

function createGenerator(params: { responseText: string; selection?: ZCodeSelection }): {
  generator: GitCommitMessageGenerator;
  textGenerator: ReturnType<typeof createTextGenerator>;
} {
  const textGenerator = createTextGenerator(params.responseText);
  const selection = params.selection ?? DEFAULT_SELECTION;
  return {
    generator: new GitCommitMessageGenerator({
      textGenerator,
      currentModelProvider: {
        async readCurrentModel() {
          return selection;
        },
      },
    }),
    textGenerator,
  };
}

function createFileChange(overrides?: Partial<GitFileChange>): GitFileChange {
  return {
    path: "/repo/packages/ui/src/GitActionMenu.tsx",
    repoRelativePath: "packages/ui/src/GitActionMenu.tsx",
    workspaceRelativePath: "packages/ui/src/GitActionMenu.tsx",
    kind: "modified",
    section: "unstaged",
    added: 12,
    removed: 4,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    ...overrides,
  };
}

function createDiff(overrides?: Partial<GitDiffResult>): GitDiffResult {
  return {
    path: "packages/ui/src/GitActionMenu.tsx",
    availability: "patch",
    patch: "@@ -1 +1 @@\n-old\n+new",
    beforeContent: null,
    afterContent: null,
    ...overrides,
  };
}

describe("GitCommitMessageGenerator", () => {
  it("returns a valid Conventional Commit message from the selected model", async () => {
    const { generator, textGenerator } = createGenerator({
      responseText: "```text\nfix(git): generate commit messages\n```",
    });

    const result = await generator.generate({
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      branchName: "main",
      files: [createFileChange()],
      diffs: [createDiff()],
    });

    expect(result).toEqual({
      message: "fix(git): generate commit messages",
      providerId: "openai-compatible",
      model: "test-model",
    });
    expect(textGenerator.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        workspaceIdentity: "ssh://host/repo",
        selection: DEFAULT_SELECTION,
        querySource: "git_commit_message",
      }),
    );
    expect(textGenerator.generateText.mock.calls[0]?.[0]).not.toHaveProperty("maxOutputTokens");
  });

  it("preserves the complete selected model until the auxiliary execution boundary", async () => {
    const selectedSelection: ZCodeSelection = {
      providerId: "openai-compatible",
      modelId: "deepseek-v4-flash",
      options: { reasoningLevel: "max" },
    };
    const { generator, textGenerator } = createGenerator({
      selection: selectedSelection,
      responseText: "fix(git): generate message",
    });

    await generator.generate({
      workspacePath: "/repo",
      branchName: "main",
      files: [createFileChange()],
      diffs: [createDiff()],
    });

    expect(textGenerator.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          providerId: selectedSelection.providerId,
          modelId: selectedSelection.modelId,
          options: { reasoningLevel: "max" },
        },
      }),
    );
  });

  it("uses the request selection instead of the Host current model", async () => {
    const requestSelection: ZCodeSelection = {
      providerId: "custom-api",
      modelId: "user-picked-model",
      options: { reasoningLevel: "high" },
    };
    // Host 当前模型是限额账号的内置选择；请求带了 renderer 草稿选择时必须完全以它为准。
    const { generator, textGenerator } = createGenerator({
      responseText: "fix(git): generate message",
      selection: { providerId: "host-account", modelId: "host-model" },
    });

    const result = await generator.generate({
      workspacePath: "/repo",
      branchName: "main",
      files: [createFileChange()],
      diffs: [createDiff()],
      selection: requestSelection,
    });

    expect(result).toMatchObject({ providerId: "custom-api", model: "user-picked-model" });
    expect(textGenerator.generateText.mock.calls[0]?.[0]).toMatchObject({
      selection: requestSelection,
    });
  });

  it("falls back to the Host current model when the request selection is incomplete", async () => {
    const { generator, textGenerator } = createGenerator({
      responseText: "fix(git): generate message",
    });

    const result = await generator.generate({
      workspacePath: "/repo",
      branchName: "main",
      files: [createFileChange()],
      diffs: [createDiff()],
      selection: { providerId: "  ", modelId: "user-picked-model" },
    });

    expect(result).toMatchObject({ providerId: "openai-compatible", model: "test-model" });
    expect(textGenerator.generateText.mock.calls[0]?.[0]).toMatchObject({
      selection: DEFAULT_SELECTION,
    });
  });

  it("adds Chinese as the current commit message language", async () => {
    const { generator, textGenerator } = createGenerator({
      responseText: "fix(git): 生成提交消息",
    });

    await generator.generate({
      workspacePath: "/repo",
      branchName: "main",
      locale: "zh-CN",
      files: [],
      diffs: [],
    });

    const prompt = textGenerator.generateText.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("Current language: Chinese");
    expect(prompt).toContain("- Write the subject and any body in the current language.");
  });

  it("falls back to English when runtime locale is unavailable", async () => {
    const dateTimeFormatSpy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("locale unavailable");
    });
    const { generator, textGenerator } = createGenerator({
      responseText: "fix(git): generate message",
    });

    try {
      await generator.generate({
        workspacePath: "/repo",
        branchName: "main",
        files: [],
        diffs: [],
      });
    } finally {
      dateTimeFormatSpy.mockRestore();
    }

    const prompt = textGenerator.generateText.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("Current language: English");
  });

  it("clips diff excerpts before calling the text generator", async () => {
    const { generator, textGenerator } = createGenerator({
      responseText: "fix(git): generate message",
    });

    await generator.generate({
      workspacePath: "/repo",
      branchName: "main",
      files: [createFileChange()],
      diffs: [createDiff({ patch: "a".repeat(3_000) })],
    });

    const prompt = textGenerator.generateText.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("...diff truncated...");
    expect(prompt.length).toBeLessThan(3_000);
  });

  it("includes current session conversation context in the prompt", async () => {
    const { generator, textGenerator } = createGenerator({
      responseText: "fix(git): 生成提交消息",
    });

    await generator.generate({
      workspacePath: "/repo",
      branchName: "main",
      locale: "zh-CN",
      files: [createFileChange()],
      diffs: [createDiff()],
      conversationContext: {
        sessionId: "session-1",
        omittedMessageCount: 2,
        messages: [
          {
            role: "user",
            content: "把自动生成内容和自动提交分开",
          },
          {
            role: "assistant",
            content: "已改为先生成提交信息，再由用户手动提交。",
          },
        ],
      },
    });

    const prompt = textGenerator.generateText.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("Current session conversation context:");
    expect(prompt).toContain("- 2 earlier messages omitted");
    expect(prompt).toContain("User: 把自动生成内容和自动提交分开");
    expect(prompt).toContain("Assistant: 已改为先生成提交信息，再由用户手动提交。");
    expect(prompt).toContain(
      "- Do not mention the conversation, chat, prompt, or user request explicitly.",
    );
  });

  it("throws a short invalid-output error when the model repeats the prompt", async () => {
    const { generator } = createGenerator({
      responseText: "Generate a Git commit message based on the workspace changes described below.",
    });

    await expect(
      generator.generate({
        workspacePath: "/repo",
        branchName: "main",
        files: [],
        diffs: [],
      }),
    ).rejects.toMatchObject({
      name: "GitCommitMessageGenerationError",
      reason: "invalid-output",
      message: "模型没有返回可用的 Conventional Commit 提交消息。",
    } satisfies Partial<GitCommitMessageGenerationError>);
  });

  it("throws model-unavailable when current model is missing", async () => {
    const textGenerator = createTextGenerator("fix(git): generate message");
    const generator = new GitCommitMessageGenerator({
      textGenerator,
      currentModelProvider: {
        async readCurrentModel() {
          return null;
        },
      },
    });

    await expect(
      generator.generate({
        workspacePath: "/repo",
        branchName: "main",
        files: [],
        diffs: [],
      }),
    ).rejects.toMatchObject({
      reason: "model-unavailable",
      message: "未读取到当前模型。",
    } satisfies Partial<GitCommitMessageGenerationError>);
    expect(textGenerator.generateText).not.toHaveBeenCalled();
  });
});
