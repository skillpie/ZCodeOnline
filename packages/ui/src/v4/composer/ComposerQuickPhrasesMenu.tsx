import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useComposerQuickPhrases } from "@/v4/composer/composerQuickPhrases.js";
import { Settings2Icon } from "lucide-react";

interface ComposerQuickPhrasesMenuProps {
  onSend: (text: string) => void;
  onManage: () => void;
}

/**
 * 发送按钮空态点击弹出的常用语面板：点击短语即发送（由调用方编排），
 * 底部「管理常用语」进入管理弹窗。数据为全局用户级常用语 store。
 */
export function ComposerQuickPhrasesMenu({ onSend, onManage }: ComposerQuickPhrasesMenuProps) {
  const { intl } = useZCodeIntl();
  const phrases = useComposerQuickPhrases();

  return (
    <div className="flex flex-col">
      <div className="max-h-64 overflow-y-auto p-1">
        {phrases.length === 0 ? (
          <p className="px-3 py-4 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.composer.quickPhrases.empty" })}
          </p>
        ) : (
          phrases.map((phrase) => (
            <Button
              key={phrase.id}
              type="button"
              variant="ghost"
              size="lg"
              className="h-auto w-full justify-start py-2 text-left text-ui-base text-foreground hover:bg-menu-hover hover:text-foreground"
              onClick={() => {
                onSend(phrase.text);
              }}
            >
              <span className="line-clamp-2 whitespace-pre-wrap">{phrase.text}</span>
            </Button>
          ))
        )}
      </div>
      <div className="border-t border-border p-1">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
          onClick={onManage}
        >
          <Settings2Icon className="size-4 text-foreground-subtle" />
          {intl.formatMessage({ id: "chat.composer.quickPhrases.manage" })}
        </Button>
      </div>
    </div>
  );
}
