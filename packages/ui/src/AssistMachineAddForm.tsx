// 「添加远程链接」内联表单（specs/web-tunnel.md §5.9）：从远程控制弹窗抽出的自包含
// 表单——草稿态（码/名/错误）归本组件所有，校验通过才回调入库；父组件负责列表状态
// 与入库（upsert + 可选改名）。独立于列表渲染：列表为空时也能添加。
import { useState } from "react";
import { normalizeAssistCode } from "@zcode/shared";
import { defaultAssistMachineName } from "@/assistMachineStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function AssistMachineAddForm({
  localCode,
  existingCodes,
  onSubmit,
  onCancel,
}: {
  /** 当前本机码：与本机重复的码不允许再添加。 */
  localCode: string | null;
  /** 已登记的远程码集合（提交时查重，防列表并发更新下的重复入库）。 */
  existingCodes: readonly string[];
  /** 校验通过：code 为归一化 16 位码，name 为去除空白的可选名称。 */
  onSubmit: (code: string, name: string) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [codeDraft, setCodeDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 码校验通过才入库；可选名称立即生效，否则由父组件走默认名（<码>的ZCode）。
  const submit = () => {
    const code = normalizeAssistCode(codeDraft);
    if (!code) {
      setError(intl.formatMessage({ id: "assistCode.dialog.addInvalid" }));
      return;
    }
    if (code === localCode || existingCodes.includes(code)) {
      setError(intl.formatMessage({ id: "assistCode.dialog.addDuplicate" }));
      return;
    }
    onSubmit(code, nameDraft.trim());
  };

  const inputClass =
    "w-full rounded-md border border-input-border-focused bg-background px-2 py-1 text-ui-base text-foreground outline-none";

  return (
    <div className="min-w-0 space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <input
        autoFocus
        value={codeDraft}
        inputMode="numeric"
        aria-label={intl.formatMessage({ id: "assistCode.dialog.addCodePlaceholder" })}
        placeholder={intl.formatMessage({ id: "assistCode.dialog.addCodePlaceholder" })}
        className={inputClass}
        onChange={(event) => {
          setCodeDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") onCancel();
        }}
      />
      <input
        value={nameDraft}
        aria-label={intl.formatMessage({ id: "assistCode.dialog.addNamePlaceholder" })}
        placeholder={
          normalizeAssistCode(codeDraft)
            ? defaultAssistMachineName(normalizeAssistCode(codeDraft) ?? "")
            : intl.formatMessage({ id: "assistCode.dialog.addNamePlaceholder" })
        }
        className={inputClass}
        onChange={(event) => setNameDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") onCancel();
        }}
      />
      {error !== null ? <p className="text-ui-sm text-destructive">{error}</p> : null}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          className="text-ui-base text-foreground-subtle hover:text-foreground"
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </button>
        <button
          type="button"
          className="text-ui-base font-medium text-primary hover:text-primary"
          onClick={submit}
        >
          {intl.formatMessage({ id: "assistCode.dialog.addConfirm" })}
        </button>
      </div>
    </div>
  );
}
