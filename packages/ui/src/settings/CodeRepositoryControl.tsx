import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  clearStoredCodeRepositoryUrl,
  saveStoredCodeRepositoryUrl,
  useCodeRepositoryUrl,
} from "@/codeRepositorySettings.js";

/**
 * 代码仓库地址行内编辑器（设置页通用区）：留空保存 = 清除设置，
 * 侧边栏「代码仓库」入口随之隐藏；保存成功后经 storedUrlSetting 的订阅通知侧边栏。
 */
export function CodeRepositoryControl() {
  const { intl } = useZCodeIntl();
  const storedUrl = useCodeRepositoryUrl() ?? "";
  const [draftUrl, setDraftUrl] = useState(storedUrl);
  const [error, setError] = useState<string | null>(null);
  // 本地输入法 composition 态：部分平台 isComposing 会提前翻 false，靠 ref 兜底。
  const compositionActiveRef = useRef(false);
  useEffect(() => {
    // 保存的归一化值（如补尾斜杠）回写草稿；外部清除时同步清空输入框。
    setDraftUrl(storedUrl);
  }, [storedUrl]);

  const isDirty = draftUrl.trim() !== storedUrl;

  const handleSave = () => {
    const trimmed = draftUrl.trim();
    if (!trimmed) {
      clearStoredCodeRepositoryUrl();
      setError(null);
      toast(intl.formatMessage({ id: "settings.codeRepository.cleared" }));
      return;
    }
    const normalized = saveStoredCodeRepositoryUrl(trimmed);
    if (!normalized) {
      setError(intl.formatMessage({ id: "settings.codeRepository.invalidUrl" }));
      return;
    }
    setError(null);
    toast(intl.formatMessage({ id: "settings.codeRepository.saved" }));
  };

  return (
    <div className="flex w-[320px] min-w-0 flex-col gap-2">
      <Input
        size="lg"
        data-testid="settings-code-repository-input"
        aria-label={intl.formatMessage({ id: "settings.codeRepository" })}
        value={draftUrl}
        spellCheck={false}
        placeholder={intl.formatMessage({ id: "settings.codeRepositoryPlaceholder" })}
        className="font-mono"
        onChange={(event) => {
          setDraftUrl(event.target.value);
          if (error) {
            setError(null);
          }
        }}
        onCompositionStart={() => {
          compositionActiveRef.current = true;
        }}
        onCompositionEnd={() => {
          compositionActiveRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (
            isImeComposingKeyEvent({
              compositionActive: compositionActiveRef.current,
              nativeEvent: event.nativeEvent,
            })
          ) {
            return;
          }
          event.preventDefault();
          handleSave();
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="settings-code-repository-clear"
          disabled={!storedUrl}
          onClick={() => {
            clearStoredCodeRepositoryUrl();
            setError(null);
            toast(intl.formatMessage({ id: "settings.codeRepository.cleared" }));
          }}
        >
          {intl.formatMessage({ id: "settings.codeRepository.clear" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="settings-code-repository-save"
          disabled={!isDirty}
          onClick={handleSave}
        >
          {intl.formatMessage({ id: "common.save" })}
        </Button>
      </div>
      {error ? (
        <p className="text-ui-base text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
