import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/**
 * Composer 模式菜单的草稿切换（纯函数，useDraftConfigControl 委托调用）。
 *
 * 产品规则：计划模式与评审模式互斥——只能二选一或不选。
 * - 开启计划（"plan"）时显式清掉评审，防止两条指令同时注入 Submission；
 * - 开启评审（"review"）时显式退出计划（planEnabled=false）；
 * - 权限单选（build/edit/yolo）与两者正交，不改评审状态；
 * - "plan-off"/"review-off" 是菜单取消勾选的显式关闭信号，只关自己。
 * 非法值返回 null，由调用方保持草稿不变。
 */
export function applyComposerModeSwitch(
  current: V4ComposerDraft,
  mode: string,
): V4ComposerDraft | null {
  if (mode === "plan" || mode === "plan-off") {
    const planEnabled = mode === "plan";
    return {
      ...current,
      mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
      planEnabled,
      ...(planEnabled ? { reviewEnabled: undefined } : {}),
      initializeFromNewTask: undefined,
    };
  }
  if (mode === "review" || mode === "review-off") {
    return {
      ...current,
      ...(mode === "review"
        ? { planEnabled: false, reviewEnabled: true as const }
        : { reviewEnabled: undefined }),
      initializeFromNewTask: undefined,
    };
  }
  const parsed = submissionModeSchema.safeParse(mode);
  if (!parsed.success) {
    return null;
  }
  return { ...current, mode: parsed.data, initializeFromNewTask: undefined };
}
