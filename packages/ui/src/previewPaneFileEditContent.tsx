import { useEffect, useRef } from "react";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 预览面板的文件编辑区：进入编辑模式后整面替换只读代码视图。
 * 刻意复用 Textarea 而不是 CodeViewer（shiki 只读渲染），也不引入行号——
 * 第一版编辑面只承担「改文本 + 保存/取消」，行号与高亮留在只读视图。
 */
export function PreviewPaneFileEditContent({
  value,
  onChange,
  fontSizePx,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** 代码内容跟随代码预览设置的字号（DESIGN.md 的代码字号例外）。 */
  fontSizePx: number;
  ariaLabel: string;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 进入编辑模式时直接落焦到文本区，省一次点击。
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  return (
    <div className={cn("h-full w-full overflow-hidden bg-background p-3", className)}>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        data-testid="preview-pane-file-edit-input"
        spellCheck={false}
        className={cn(
          // 覆盖 Textarea 的表单外观：编辑区是整面代码画布，不是表单输入框
          // （field-sizing-fixed 阻止按内容扩张，同 GitActionMenu 的 Textarea 覆盖惯例）。
          "h-full field-sizing-fixed resize-none rounded-md border-border bg-background font-mono leading-relaxed",
          "focus-visible:ring-0 focus-visible:ring-offset-0",
        )}
        style={{ fontSize: `${fontSizePx}px` }}
      />
    </div>
  );
}
