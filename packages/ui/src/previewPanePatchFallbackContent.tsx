import { useMemo } from "react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import {
  HighlightedLightweightDiffPreview,
} from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import {
  getPatchPreviewNewFileLineNumbers,
  getPlainTextPatchFallbackLines,
} from "@/lib/patchDiffPreview.js";
import { useGitBlameLineResolver } from "@/hooks/useGitBlame.js";
import type { CodePreviewSettings } from "@/store/index.js";

interface PatchFallbackContentProps {
  patch: string;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: "light" | "dark";
  sourcePath?: string;
  sourceTitle?: string;
  workspacePath?: string;
}

export function PatchFallbackContent({
  patch,
  codePreviewSettings,
  resolvedTheme,
  sourcePath,
  sourceTitle,
  workspacePath,
}: PatchFallbackContentProps) {
  const createBlameResolver = useGitBlameLineResolver();
  const plainTextFallbackLines = useMemo(() => getPlainTextPatchFallbackLines(patch), [patch]);
  // 行号映射长度必须与预览行一致，否则禁用 blame（防御截断语义变化导致的错位）
  const blameLineNumbers = useMemo(() => {
    if (!plainTextFallbackLines) return null;
    const mapping = getPatchPreviewNewFileLineNumbers(patch);
    if (!mapping || mapping.length !== plainTextFallbackLines.length) return null;
    return mapping;
  }, [patch, plainTextFallbackLines]);

  // 整文件一次取回 + 全局按路径缓存（hook 内），避免快速划过多行时反复 spawn git
  const resolveBlameLine = useMemo(() => {
    if (!workspacePath || !sourcePath) return undefined;
    return createBlameResolver(workspacePath, sourcePath);
  }, [createBlameResolver, workspacePath, sourcePath]);
  const highlightPath = sourcePath ?? sourceTitle;
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(highlightPath, patch),
    [highlightPath, patch],
  );
  const highlightTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;

  if (plainTextFallbackLines) {
    // @pierre/diffs 的 PatchDiff 只支持单文件 patch。日志里出现过多文件
    // patch 直接进入右侧预览，生产包渲染阶段会抛错并卡住侧栏，所以这里统一降级成轻量 diff。
    // edit 打开的右侧 Diff 对新增/删除文件也会走这条轻量 fallback；之前只渲染纯文本，
    // 导致 HTML/TS 等文件在右侧失去语法高亮。这里复用异步 Shiki 高亮，保留不卡顿的轻量渲染路径。
    return (
      <HighlightedLightweightDiffPreview
        blameLineNumbers={blameLineNumbers ?? undefined}
        className="h-full"
        codePreviewSettings={codePreviewSettings}
        data-patch-plain-text-preview
        language={highlightLanguage}
        lines={plainTextFallbackLines}
        path={highlightPath}
        resolveBlameLine={resolveBlameLine}
        theme={highlightTheme}
      />
    );
  }

  return (
    <DiffViewer
      patch={patch}
      diffClassName="block"
      fontSizePx={codePreviewSettings.fontSizePx}
      lightTheme={codePreviewSettings.lightTheme}
      darkTheme={codePreviewSettings.darkTheme}
      resolveBlameLine={resolveBlameLine}
      themeType={resolvedTheme}
    />
  );
}
