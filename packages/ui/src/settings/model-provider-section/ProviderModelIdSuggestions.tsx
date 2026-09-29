import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { ProviderModelListItem } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { modelEditorControlStyle } from "@/settings/model-provider-section/modelEditorControlStyle.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";

const MAX_VISIBLE_SUGGESTIONS = 50;

/**
 * 添加模型弹窗的模型 ID 字段：一键获取模型后，输入框出现候选下拉，
 * 按输入过滤；选中回调由调用方写入草稿（并按候选自带大小补空字段）。
 */
export function ProviderModelIdField({
  value,
  readOnly = false,
  autoFocus = false,
  suggestions,
  onChange,
  onBlur,
  onEnterKey,
  onPick,
}: {
  value: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  suggestions?: readonly ProviderModelListItem[];
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** Enter 提交（带输入法组合判定），由弹窗注入。 */
  onEnterKey: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onPick: (item: ProviderModelListItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const hasSuggestions = Boolean(suggestions?.length);
  const query = value.trim().toLowerCase();
  const filtered = suggestions
    ? query
      ? suggestions.filter((item) => item.id.toLowerCase().includes(query))
      : suggestions
    : [];
  return (
    <div className="relative">
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        type="text"
        autoFocus={autoFocus}
        size="lg"
        className={cn("font-mono", hasSuggestions ? "pr-9" : "", modelEditorControlStyle(false))}
        readOnly={readOnly}
        value={value}
        placeholder={intl.formatMessage({ id: "settings.modelProvider.modelId" })}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onBlur={onBlur}
        onKeyDown={onEnterKey}
      />
      {hasSuggestions ? (
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "settings.modelProvider.pickModelId" })}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={(event) => {
            event.preventDefault();
            setOpen((previous) => !previous);
          }}
        >
          <ChevronDownIcon className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      {hasSuggestions && open ? (
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover shadow-md"
          role="listbox"
          aria-label={intl.formatMessage({ id: "settings.modelProvider.pickModelId" })}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.modelIdSuggestionsEmpty" })}
            </p>
          ) : (
            filtered.slice(0, MAX_VISIBLE_SUGGESTIONS).map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={value === item.id}
                className="block w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left font-mono text-ui-caption text-foreground hover:bg-hover"
                onClick={(event) => {
                  event.preventDefault();
                  onPick(item);
                  setOpen(false);
                }}
              >
                {item.id}
              </button>
            ))
          )}
          {filtered.length > MAX_VISIBLE_SUGGESTIONS ? (
            <p className="border-t border-border px-3 py-1.5 text-ui-caption text-foreground-subtlest">
              {intl.formatMessage(
                { id: "settings.modelProvider.modelIdSuggestionsMore" },
                { count: filtered.length - MAX_VISIBLE_SUGGESTIONS },
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
