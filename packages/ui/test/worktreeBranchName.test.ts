import { describe, expect, test } from "vitest";
import { buildWorktreeBranchName } from "@/lib/worktreeBranchName.js";

describe("buildWorktreeBranchName", () => {
  test("分支名 = feat/{6位随机数}，目录名由服务端按分支名净化派生为 feat-{同后缀}", () => {
    const branchName = buildWorktreeBranchName(new Set());
    expect(branchName).toMatch(/^feat\/\d{6}$/);
  });

  test("与已有分支撞名时重摇", () => {
    const existing = new Set<string>();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const branchName = buildWorktreeBranchName(existing);
      expect(existing.has(branchName)).toBe(false);
      existing.add(branchName);
    }
  });
});
