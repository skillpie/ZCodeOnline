import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// v3.16.2 起 sidebar 切换为官方 ProjectSidebar，新建任务按钮由 NewTaskButtonGroup 承载；
// fork 能力「只读态禁用并解释原因、正常态不重复挂 tooltip」随组件迁移，断言同步指向新实现。
describe("workspace sidebar new task tooltip", () => {
  it("正常状态不显示重复提示，仅只读状态展示禁用原因", async () => {
    const source = await readFile(
      new URL("../src/NewTaskButtonGroup.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("if (!disabledReason) return button;");
    expect(source).toContain("<ControlHintTooltip title={disabledReason}>");
  });

  it("ProjectSidebar 侧栏接线只读原因，禁用态与 tooltip 同源", async () => {
    const source = await readFile(
      new URL("../src/project-sidebar/ProjectSidebarNavigation.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("disabled={Boolean(props.workspaceReadOnlyReason)}");
    expect(source).toContain("disabledReason={props.workspaceReadOnlyReason ?? undefined}");
  });
});
