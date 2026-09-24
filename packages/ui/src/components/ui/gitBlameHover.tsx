/**
 * useGitBlameHoverTooltip —— 代码视图的 git blame 悬停提示（悬停 1 秒后弹出）。
 *
 * 实现要点：@pierre/diffs 在 Shadow DOM 内部有自己的行悬停处理，可能在 bubble 阶段
 * stopPropagation，React 合成事件（挂在外层根节点）会收不到事件。因此这里用
 * **捕获阶段的原生监听**挂到容器上（capture 先于库内部处理），事件目标经
 * composedPath 穿透 Shadow DOM 识别：
 * - 富 diff / 纯文件视图：行元素带 `data-line`（新文件行号）
 * - 轻量 diff：行元素带 `data-blame-row`（映射后的新文件行号，删除行为 null 不渲染属性）
 * 提示浮层通过 portal 渲染在 document.body，跟随鼠标位置。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface GitBlameHoverInfo {
  author: string;
  time: number;
  committed: boolean;
}

export type ResolveGitBlameLine = (line: number) => Promise<GitBlameHoverInfo | null>;

const BLAME_HOVER_DELAY_MS = 1000;

interface BlameTooltipState {
  x: number;
  y: number;
  text: string;
}

function findBlameLineFromPath(path: EventTarget[]): number | null {
  for (const node of path) {
    if (node instanceof HTMLElement) {
      const blameRow = node.getAttribute("data-blame-row");
      if (blameRow !== null && blameRow !== "") {
        const parsed = Number(blameRow);
        if (!Number.isNaN(parsed)) return parsed;
      }
      const dataLine = node.getAttribute("data-line");
      if (dataLine !== null) {
        const parsed = Number(dataLine);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
  }
  return null;
}

export function useGitBlameHoverTooltip(resolveBlameLine: ResolveGitBlameLine | undefined): {
  /** 挂到滚动容器的 ref（捕获阶段监听随挂载/卸载自动增删） */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 悬停提示浮层（已含 portal），调用方原样渲染进 JSX 即可 */
  tooltip: ReactNode;
} {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoveredLineRef = useRef<number | null>(null);
  const [tooltipState, setTooltip] = useState<BlameTooltipState | null>(null);
  const resolveRef = useRef(resolveBlameLine);
  resolveRef.current = resolveBlameLine;

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !resolveBlameLine) return;

    const hide = () => {
      clearHoverTimer();
      hoveredLineRef.current = null;
      setTooltip(null);
    };

    // capture：在 @pierre/diffs 内部 hover 处理（可能 stopPropagation）之前截获事件
    const handleMouseMove = (event: MouseEvent) => {
      const line = findBlameLineFromPath(event.composedPath());
      if (line === null) {
        hoveredLineRef.current = null;
        clearHoverTimer();
        setTooltip(null);
        return;
      }
      if (hoveredLineRef.current === line) return;
      hoveredLineRef.current = line;
      clearHoverTimer();
      setTooltip(null);
      const clientX = event.clientX;
      const clientY = event.clientY;
      hoverTimerRef.current = window.setTimeout(() => {
        void resolveRef.current?.(line).then((info) => {
          if (hoveredLineRef.current !== line || !info) return;
          setTooltip({
            x: clientX,
            y: clientY,
            text: info.committed
              ? `${info.author} · ${new Date(info.time * 1000).toLocaleDateString()}`
              : intl.formatMessage({ id: "git.blame.notCommitted" }),
          });
        });
      }, BLAME_HOVER_DELAY_MS);
    };

    container.addEventListener("mousemove", handleMouseMove, true);
    container.addEventListener("mouseleave", hide, true);
    return () => {
      container.removeEventListener("mousemove", handleMouseMove, true);
      container.removeEventListener("mouseleave", hide, true);
      clearHoverTimer();
    };
  }, [resolveBlameLine, intl, clearHoverTimer]);

  const tooltip = tooltipState
    ? createPortal(
        <div
          className="pointer-events-none fixed z-[80] max-w-96 rounded-lg border border-popover-border bg-popover px-2.5 py-1.5 text-ui-sm text-popover-foreground shadow-md"
          style={{ left: tooltipState.x + 12, top: tooltipState.y + 16 }}
        >
          {tooltipState.text}
        </div>,
        document.body,
      )
    : null;

  return { containerRef, tooltip };
}
