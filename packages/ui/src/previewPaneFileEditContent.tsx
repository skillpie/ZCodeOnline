import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import type { CSSProperties } from "react";
import type { BundledTheme, ThemedToken } from "shiki";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { highlightCode, type TokenizedCode } from "@/lib/shikiHighlighter.js";

/** 编辑高亮的防抖间隔。输入期间沿用上一次着色，停顿后才重新 tokenize。 */
const HIGHLIGHT_DEBOUNCE_MS = 200;
/** 大文件 tokenize 成本高，防抖拉长以避免连续输入时反复重排。 */
const HIGHLIGHT_DEBOUNCE_LARGE_FILE_MS = 600;
/** 超过该字符数不再做编辑态高亮（与 diff 预览的 12 万字符上限同思路，放宽到预览上限量级）。 */
const HIGHLIGHT_MAX_CHARS = 256_000;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timerId = setTimeout(() => setDebounced(value), delayMs);
    return () => {
      clearTimeout(timerId);
    };
  }, [delayMs, value]);
  return debounced;
}

/** 与只读 CodeViewer 共用同一个 shiki 高亮入口（含模块级缓存），保证编辑态与预览态颜色一致。 */
function useTokenizedEditDraft(params: {
  code: string;
  language: string;
  theme: BundledTheme;
}): TokenizedCode | null {
  const { code, language, theme } = params;
  const [tokenizedCode, setTokenizedCode] = useState<TokenizedCode | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 命中缓存时同步返回结果，未命中时先返回 null 等异步回调，组件停在无高亮状态。
    const tokenized = highlightCode(code, language, theme, (result) => {
      if (!cancelled) {
        setTokenizedCode(result);
      }
    });
    if (tokenized) {
      setTokenizedCode(tokenized);
    }
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  return tokenizedCode;
}

function renderTokenLine(tokens: readonly ThemedToken[] | undefined) {
  if (!tokens) {
    return null;
  }

  return tokens.map((token, index) => {
    // fontStyle 是 shiki 的位掩码：1 斜体 / 2 粗体 / 4 下划线。
    const style =
      typeof token.fontStyle === "number" && token.fontStyle !== 0
        ? {
            ...(token.fontStyle & 1 ? { fontStyle: "italic" as const } : {}),
            ...(token.fontStyle & 2 ? { fontWeight: "bold" as const } : {}),
            ...(token.fontStyle & 4 ? { textDecoration: "underline" as const } : {}),
          }
        : undefined;
    return (
      <span key={`${index}:${token.content}`} style={{ color: token.color, ...style }}>
        {token.content}
      </span>
    );
  });
}

/**
 * 预览面板的文件编辑区：透明输入框叠在 shiki 高亮层上（highlight-within-textarea）。
 * 高亮层与输入框必须保持完全一致的字体度量（等宽字体、字号、行高、内边距、tabSize），
 * 否则叠层会错位；行结构实时来自当前草稿，颜色来自上一次 tokenize 结果（防抖）。
 */
export function PreviewPaneFileEditContent({
  value,
  onChange,
  fontSizePx,
  language,
  theme,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** 代码内容跟随代码预览设置的字号（DESIGN.md 的代码字号例外）。 */
  fontSizePx: number;
  language: string;
  theme: BundledTheme;
  ariaLabel: string;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  // IME 组合期间（中文/日文输入法）合成文本是输入框原生渲染的，
  // 透明文字会让用户看不到正在输入的内容；组合期间临时显示原生文字并隐藏高亮层。
  const [isComposing, setIsComposing] = useState(false);
  const highlightDebounceMs =
    value.length > 64_000 ? HIGHLIGHT_DEBOUNCE_LARGE_FILE_MS : HIGHLIGHT_DEBOUNCE_MS;
  const debouncedValue = useDebouncedValue(value, highlightDebounceMs);
  const shouldHighlight = debouncedValue.length <= HIGHLIGHT_MAX_CHARS;
  const tokenized = useTokenizedEditDraft({
    code: shouldHighlight ? debouncedValue : "",
    language,
    theme,
  });
  // 行结构必须实时跟随输入框值，只让颜色滞后：行数错位会让整层高亮漂移。
  const draftLines = useMemo(() => value.split("\n"), [value]);

  // 进入编辑模式时直接落焦到文本区，省一次点击。
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  // 高亮层不自己滚动（overflow-hidden 仍可编程滚动），视口完全跟随输入框，双向同步。
  const syncHighlightScroll = useCallback(() => {
    const highlight = highlightRef.current;
    const textarea = textareaRef.current;
    if (!highlight || !textarea) {
      return;
    }
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  useEffect(() => {
    syncHighlightScroll();
  }, [syncHighlightScroll, value]);

  // 两个图层的共享字体度量：任何一边单独调整都会造成叠层错位。
  const codeStyle: CSSProperties = {
    fontSize: `${fontSizePx}px`,
    lineHeight: 1.625,
    tabSize: 4,
  };

  return (
    <div className={cn("h-full w-full overflow-hidden bg-background p-3", className)}>
      <div className="relative h-full w-full overflow-hidden rounded-md border border-border bg-background">
        <pre
          ref={highlightRef}
          aria-hidden="true"
          data-testid="preview-pane-file-edit-highlight"
          className={cn(
            "pointer-events-none absolute inset-0 m-0 overflow-hidden px-3 py-3 font-mono whitespace-pre text-foreground",
            isComposing && "opacity-0",
          )}
          style={codeStyle}
        >
          <code>
            {draftLines.map((line, index) => (
              <Fragment key={index}>
                {renderTokenLine(tokenized?.tokens[index])}
                {"\n"}
              </Fragment>
            ))}
          </code>
        </pre>
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncHighlightScroll}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          aria-label={ariaLabel}
          data-testid="preview-pane-file-edit-input"
          spellCheck={false}
          wrap="off"
          className={cn(
            // 覆盖 Textarea 的表单外观：编辑区是整面代码画布，不是表单输入框
            // （field-sizing-fixed 阻止按内容扩张，同 GitActionMenu 的 Textarea 覆盖惯例）。
            "absolute inset-0 h-full field-sizing-fixed resize-none overflow-auto rounded-md border-border bg-transparent px-3 py-3 font-mono caret-foreground selection:bg-selected",
            "focus-visible:ring-0 focus-visible:ring-offset-0",
            isComposing ? "text-foreground" : "text-transparent",
          )}
          style={codeStyle}
        />
      </div>
    </div>
  );
}
