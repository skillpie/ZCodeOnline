/**
 * 组件级 window 通道命令监听：动作可用性与宿主组件可见性同源的命令在这里消费。
 *
 * useAppKeyboard 的处理器表挂在 App 根部，适合全局命令；头部 Git 工具这类
 * 「提交入口仅在脏仓库展示、拉取仅在干净且有上游时展示」的命令若上提到根部，
 * 可用性判定会与组件状态脱钩。本 hook 沿用 composer 工具条热键
 * （v4/composer/toolbarShortcuts）的组件级消费先例：监听随宿主挂载注册一次，
 * enabled 在分发时经 ref 实时判定——不可用时放行事件（不 preventDefault），
 * 与 useAppKeyboard 的 null handler 语义一致。
 *
 * 键位知识仍全部收敛在 shortcuts 内核（命令表 + 生效表 + matcher），本文件
 * 不认识任何具体按键。组件级命令不得进入 App 处理器表，否则同键会双触发；
 * 跨命令的键位冲突仍由设置页冲突检测统一把守。
 */
import { useEffect, useRef } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "./bindings.js";
import { useEffectiveShortcutBindings } from "./useShortcutBindings.js";

export function useShortcutCommandListener(
  commandId: ShortcutCommandId,
  enabled: boolean,
  onTrigger: () => void,
): void {
  const effective = useEffectiveShortcutBindings();
  const stateRef = useRef({ enabled, onTrigger, effective });
  stateRef.current = { enabled, onTrigger, effective };

  useEffect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) {
        return;
      }
      // 录制态键盘归录制器独占（与 useAppKeyboard / 工具条热键同一约定）。
      if (isShortcutRecordingActive()) {
        return;
      }
      const current = stateRef.current;
      if (!current.enabled) {
        return;
      }
      // 焦点在可编辑元素（聊天输入框/搜索框/终端）时放行纯 Shift+可打印键，
      // 否则用户打不出对应大写字母（与 useAppKeyboard 同一条输入保护）。
      const editableTarget = isEditableShortcutEventTarget(event.target);
      for (const binding of current.effective[commandId] ?? []) {
        if (editableTarget && isShiftOnlyPrintableBinding(binding)) {
          continue;
        }
        if (matchesShortcutBinding(event, binding)) {
          event.preventDefault();
          current.onTrigger();
          return;
        }
      }
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [commandId]);
}
