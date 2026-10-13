import { describe, expect, it } from "vitest";
import {
  getMentionPanelGroupOrder,
  getSessionMentionWorkspaceScope,
} from "../src/mentions/mentionPanelRouting.js";

describe("getMentionPanelGroupOrder", () => {
  it("routes @ through the fixed context group order", () => {
    expect(getMentionPanelGroupOrder("@")).toEqual(["plugins", "files", "sessions", "whiteboards"]);
  });

  it("keeps the legacy # and $ candidate panels", () => {
    expect(getMentionPanelGroupOrder("#")).toEqual(["sessions"]);
    // 本地在 $ 面板追加 skill-market 分组（SkillPie 技能市场入口，specs/skill-market.md）。
    expect(getMentionPanelGroupOrder("$")).toEqual(["skills", "skill-market"]);
  });

  it("只让 # 扩展对话 workspace 范围", () => {
    expect(getSessionMentionWorkspaceScope("#")).toBe("same-authority-workspaces");
    expect(getSessionMentionWorkspaceScope("@")).toBe("current-workspace");
    expect(getSessionMentionWorkspaceScope("$")).toBe("current-workspace");
    expect(getSessionMentionWorkspaceScope(null)).toBe("current-workspace");
  });
});
