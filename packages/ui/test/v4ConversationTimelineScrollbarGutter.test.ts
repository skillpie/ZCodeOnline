import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const readTimelineSource = () =>
  readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8").replaceAll("\r\n", "\n");

describe("ConversationTimeline scrollbar gutter", () => {
  it("reserves stable scrollbar space on the shared conversation viewport", () => {
    const source = readTimelineSource();

    // 滚动视口仍是 overflow-y-auto + [scrollbar-gutter:stable]，中间新增 overscroll-contain
    // （配合 overflow-x-hidden 防宽内容把横轴算成 auto 触发横向滚动）。
    expect(source).toContain("overflow-y-auto overscroll-contain [scrollbar-gutter:stable]");
  });

  it("exposes and applies the share selection scroll lock", () => {
    const source = readTimelineSource();

    expect(source).toContain(
      'data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}',
    );
    expect(source).toContain('backgroundScrollLocked && "!overflow-y-hidden"');
  });

  it("share selection mode hides the turn navigator so the share flow owns the left rail", () => {
    const source = readTimelineSource();
    const navigatorIndex = source.indexOf("<ConversationTurnNavigator\n");

    expect(navigatorIndex).toBeGreaterThan(-1);
    expect(source.slice(navigatorIndex - 120, navigatorIndex)).toContain(
      "hideTurnNavigator ? null : (",
    );
  });
});
