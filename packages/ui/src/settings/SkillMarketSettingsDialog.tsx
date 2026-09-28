import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  DEFAULT_SKILL_MARKET_ENTRY_URL,
  clearStoredSkillMarketUrl,
  resolveSkillMarketEntryUrl,
  saveStoredSkillMarketUrl,
} from "@/skillMarketUrl.js";

/**
 * 技能市场设置弹窗：配置左侧边栏「技能市场」入口访问的链接。
 * 保存后由 SkillMarketEmbeddedView 在下次挂载时读取生效（视图随主区切换卸载/重挂）。
 */
export function SkillMarketSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draftUrl, setDraftUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 本地输入法 composition 态：部分平台 isComposing 会提前翻 false，靠 ref 兜底。
  const compositionActiveRef = useRef(false);
  useEffect(() => {
    // 每次打开都重新读取当前生效链接，丢弃上次未保存的草稿与错误提示。
    if (open) {
      setDraftUrl(resolveSkillMarketEntryUrl());
      setError(null);
    }
  }, [open]);

  const handleSave = () => {
    const normalized = saveStoredSkillMarketUrl(draftUrl);
    if (!normalized) {
      setError(intl.formatMessage({ id: "settings.skills.marketSettings.invalidUrl" }));
      return;
    }
    toast(intl.formatMessage({ id: "settings.skills.marketSettings.saved" }));
    onOpenChange(false);
  };

  const handleResetToDefault = () => {
    clearStoredSkillMarketUrl();
    setDraftUrl(DEFAULT_SKILL_MARKET_ENTRY_URL);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="skill-market-settings-dialog"
        className="w-[min(480px,calc(100vw-2rem))] max-w-none"
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.skills.marketSettings.title" })}
        </DialogTitle>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.skills.marketSettings.description" })}
        </p>
        <div className="space-y-1.5">
          <label
            htmlFor="skill-market-settings-url-input"
            className="text-ui-sm font-medium text-foreground"
          >
            {intl.formatMessage({ id: "settings.skills.marketSettings.urlLabel" })}
          </label>
          <Input
            id="skill-market-settings-url-input"
            type="text"
            inputMode="url"
            size="lg"
            autoFocus
            data-testid="skill-market-settings-url-input"
            aria-label={intl.formatMessage({ id: "settings.skills.marketSettings.urlLabel" })}
            value={draftUrl}
            spellCheck={false}
            onChange={(event) => setDraftUrl(event.target.value)}
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
          {error ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.skills.marketSettings.defaultHint" },
              { url: DEFAULT_SKILL_MARKET_ENTRY_URL },
            )}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.skills.marketSettings.ssoHint" })}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            data-testid="skill-market-settings-reset"
            onClick={handleResetToDefault}
          >
            {intl.formatMessage({ id: "settings.skills.marketSettings.reset" })}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              variant="default"
              size="lg"
              data-testid="skill-market-settings-save"
              onClick={handleSave}
            >
              {intl.formatMessage({ id: "common.save" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
