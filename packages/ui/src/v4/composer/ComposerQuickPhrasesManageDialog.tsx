import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  addComposerQuickPhrase,
  removeComposerQuickPhrase,
  useComposerQuickPhrases,
} from "@/v4/composer/composerQuickPhrases.js";
import { Trash2Icon } from "lucide-react";

interface ComposerQuickPhrasesManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 常用语管理弹窗：添加（回车 / 按钮）与逐条删除；不做编辑与排序。 */
export function ComposerQuickPhrasesManageDialog({
  open,
  onOpenChange,
}: ComposerQuickPhrasesManageDialogProps) {
  const { intl } = useZCodeIntl();
  const phrases = useComposerQuickPhrases();
  const [draft, setDraft] = useState("");
  const draftTrimmed = draft.trim();

  const handleAdd = () => {
    if (!draftTrimmed) return;
    addComposerQuickPhrase(draftTrimmed);
    setDraft("");
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    handleAdd();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="gap-2 px-6 py-5 pb-4">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "chat.composer.quickPhrases.manage" })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-2 px-6 pb-3">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={intl.formatMessage({ id: "chat.composer.quickPhrases.inputPlaceholder" })}
            className="flex-1"
          />
          <Button type="button" variant="outline" disabled={!draftTrimmed} onClick={handleAdd}>
            {intl.formatMessage({ id: "chat.composer.quickPhrases.add" })}
          </Button>
        </div>
        <div className="max-h-72 overflow-y-auto px-3 pb-2">
          {phrases.length === 0 ? (
            <p className="px-3 py-4 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.composer.quickPhrases.empty" })}
            </p>
          ) : (
            phrases.map((phrase) => (
              <div
                key={phrase.id}
                className="group/phrase-row flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-menu-hover"
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ui-base text-foreground">
                  {phrase.text}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "chat.composer.quickPhrases.delete" })}
                  className="opacity-0 group-hover/phrase-row:opacity-100 [@media(hover:none)]:opacity-100"
                  onClick={() => {
                    removeComposerQuickPhrase(phrase.id);
                  }}
                >
                  <Trash2Icon className="size-3.5 text-foreground-subtle" />
                </Button>
              </div>
            ))
          )}
        </div>
        <DialogFooter className="px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {intl.formatMessage({ id: "chat.composer.quickPhrases.done" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
