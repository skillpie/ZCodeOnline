import { useEffect, useState } from "react";

/** 删除类按钮的防误触延迟：hover / focus 持续该时长后才浮现。触屏无 hover，调用方传 0 立即显示。 */
export const DELETE_REVEAL_DELAY_MS = 2000;

/**
 * 悬停/聚焦持续 `delayMs` 后才置 true 的延迟浮现开关；
 * active 变 false 立即复位并取消计时，避免划过行时残留已浮现状态。
 */
export function useSustainedHover(active: boolean, delayMs: number): boolean {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!active) {
      setRevealed(false);
      return;
    }
    if (delayMs <= 0) {
      setRevealed(true);
      return;
    }

    const timerId = window.setTimeout(() => {
      setRevealed(true);
    }, delayMs);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [active, delayMs]);

  return revealed;
}
