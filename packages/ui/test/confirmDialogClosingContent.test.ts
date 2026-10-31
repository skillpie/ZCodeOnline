import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("ConfirmDialogHost closing content", () => {
  it("keeps the last request content during close animation", () => {
    const source = readSource("packages/ui/src/ConfirmDialog.tsx");

    expect(source).toContain("const displayedRequestRef = useRef(pendingRequest);");
    expect(source).toContain("displayedRequestRef.current = pendingRequest;");
    expect(source).toContain(
      "const displayedRequest = pendingRequest ?? displayedRequestRef.current;",
    );
    expect(source).toContain("{displayedRequest?.title}");
    expect(source).toContain("{displayedRequest.description}");
    expect(source).toContain("displayedRequest?.confirmLabel ??");
    expect(source).toContain("displayedRequest?.cancelLabel ??");
  });

  it("Automation confirmation 只覆盖共享弹窗的宽高", () => {
    const source = readSource("packages/ui/src/ConfirmDialog.tsx");
    const presentationSource = readSource(
      "packages/ui/src/settings/automationConfirmDialogPresentation.ts",
    );

    expect(source).toContain('displayedRequest?.presentation === "automation-confirmation"');
    expect(source).toContain("AUTOMATION_CONFIRM_DIALOG_CONTENT_CLASS");
    expect(presentationSource).toContain("min-h-[180px] w-[min(448px,calc(100vw-2rem))]");
    expect(presentationSource).toContain('"line-clamp-3 break-words whitespace-pre-line');
  });

  it("长路径描述不撑爆隐式 grid 轨道（wrap-anywhere 计入 min-content）", () => {
    const source = readSource("packages/ui/src/ConfirmDialog.tsx");

    // git 撤销确认等场景会把无断行点的文件路径塞进描述；wrap-anywhere（overflow-wrap:
    // anywhere）让断行机会计入 min-content，DialogContent 的隐式 grid 列才不会被撑出卡片，
    // justify-end 的按钮也才不会一起被推到框外。break-words 不参与 min-content，救不了这个场景。
    expect(source).toContain(
      '"whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle wrap-anywhere"',
    );
  });
});
