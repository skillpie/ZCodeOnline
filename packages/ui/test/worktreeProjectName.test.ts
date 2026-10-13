import { describe, expect, test } from "vitest";
import { buildWorktreeProjectName, sanitizeWorktreeRefSegment } from "@/lib/worktreeProjectName.js";

describe("sanitizeWorktreeRefSegment", () => {
  test("取路径末段并清理非法字符", () => {
    expect(sanitizeWorktreeRefSegment("/Users/jensen/Projects/fengqun-scm")).toBe("fengqun-scm");
    expect(sanitizeWorktreeRefSegment("my repo")).toBe("my-repo");
    expect(sanitizeWorktreeRefSegment("a:b~c")).toBe("abc");
    expect(sanitizeWorktreeRefSegment("-.lead.-")).toBe("lead");
  });

  test("全非法字符时回退 worktree", () => {
    expect(sanitizeWorktreeRefSegment("~~~")).toBe("worktree");
  });
});

describe("buildWorktreeProjectName", () => {
  test("目录名 = {工程名}-{6位随机数}，分支名 = feat/{同6位随机数}", () => {
    const plan = buildWorktreeProjectName("/repo/fengqun-scm", new Set());
    const suffix = plan.directoryName.match(/-(\d{6})$/)?.[1];
    expect(plan.directoryName).toMatch(/^fengqun-scm-\d{6}$/);
    expect(suffix).toBeTruthy();
    expect(plan.branchName).toBe(`feat/${suffix}`);
  });

  test("分支与已有分支撞名时重摇，目录名后缀跟随新摇结果", () => {
    const existing = new Set<string>();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const plan = buildWorktreeProjectName("fengqun-scm", existing);
      expect(existing.has(plan.branchName)).toBe(false);
      const suffix = plan.directoryName.match(/-(\d+)$/)?.[1] ?? "";
      expect(plan.branchName).toBe(`feat/${suffix}`);
      existing.add(plan.branchName);
    }
  });

  test("工程目录名含非法 ref 字符时净化", () => {
    const plan = buildWorktreeProjectName("/repo/my:repo", new Set());
    expect(plan.directoryName).toMatch(/^myrepo-\d{6}$/);
    expect(plan.branchName).toMatch(/^feat\/\d{6}$/);
  });
});
