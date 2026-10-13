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
  test("默认名 = {工程名}-{4位随机数}", () => {
    const name = buildWorktreeProjectName("/repo/fengqun-scm", new Set());
    expect(name).toMatch(/^fengqun-scm-\d{4}$/);
  });

  test("与已有分支撞名时重摇（仍保持 4 位随机形态）", () => {
    const existing = new Set<string>();
    let first: string | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const name = buildWorktreeProjectName("fengqun-scm", existing);
      if (first === null) {
        first = name;
      }
      expect(existing.has(name)).toBe(false);
      existing.add(name);
    }
    expect(first).toMatch(/^fengqun-scm-\d{4}$/);
  });

  test("工程目录名含非法 ref 字符时净化", () => {
    const name = buildWorktreeProjectName("/repo/my:repo", new Set());
    expect(name).toMatch(/^myrepo-\d{4}$/);
  });
});
