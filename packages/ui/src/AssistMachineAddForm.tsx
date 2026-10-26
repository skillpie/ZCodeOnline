// 「添加远程链接」内联表单（specs/web-tunnel.md §5.9）：从远程控制弹窗抽出的自包含
// 表单——草稿态（码/错误/校验中）归本组件所有；提交先经平台 redeemAssistCode 向
// relay 预检（兑换只校验码、不消费），预检成功才回调入库。名称不在添加时设置：
// 码此时还没有辨识度，连接后由列表内联改名。独立于列表渲染：列表为空时也能添加。
import { useState } from "react";
import { parseAssistCodeInput } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
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
  /** 预检通过：code 为归一化 8 位码；入库（默认名 = <码>的ZCode）由父组件负责。 */
  onSubmit: (code: string) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [codeDraft, setCodeDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  // 输入接受完整远程链接（https://host/<码>）或裸码/分组码，实时提取用于校验。
  const parsedCode = parseAssistCodeInput(codeDraft);

  // 码格式校验 + relay 预检都通过才入库；预检失败把原因（无效/限流/网络）原样展示，
  // 预检期间禁用按钮防止并发提交与误关。
  const submit = async () => {
    if (verifying) return;
    if (!parsedCode) {
      setError(intl.formatMessage({ id: "assistCode.dialog.addInvalid" }));
      return;
    }
    if (parsedCode === localCode || existingCodes.includes(parsedCode)) {
      setError(intl.formatMessage({ id: "assistCode.dialog.addDuplicate" }));
      return;
    }
    const redeem = platform.redeemAssistCode?.bind(platform);
    if (!redeem) {
      setError(intl.formatMessage({ id: "assistCode.dialog.addVerifyUnavailable" }));
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const result = await redeem(parsedCode);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onSubmit(parsedCode);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : intl.formatMessage({ id: "assistCode.dialog.addVerifyUnavailable" }),
      );
    } finally {
      setVerifying(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-input-border-focused bg-background px-2 py-1 text-ui-base text-foreground outline-none";

  return (
    <div className="min-w-0 space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <input
        autoFocus
        value={codeDraft}
        inputMode="url"
        aria-label={intl.formatMessage({ id: "assistCode.dialog.addCodePlaceholder" })}
        placeholder={intl.formatMessage({ id: "assistCode.dialog.addCodePlaceholder" })}
        className={inputClass}
        onChange={(event) => {
          setCodeDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
          if (event.key === "Escape" && !verifying) onCancel();
        }}
      />
      {error !== null ? <p className="text-ui-sm text-destructive">{error}</p> : null}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          disabled={verifying}
          className="text-ui-base text-foreground-subtle hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </button>
        <button
          type="button"
          disabled={verifying}
          className="text-ui-base font-medium text-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void submit()}
        >
          {verifying
            ? intl.formatMessage({ id: "assistCode.dialog.addVerifying" })
            : intl.formatMessage({ id: "assistCode.dialog.addConfirm" })}
        </button>
      </div>
    </div>
  );
}
