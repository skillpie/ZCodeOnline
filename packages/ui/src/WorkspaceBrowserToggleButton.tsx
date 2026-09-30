import { TID_BROWSER_TOGGLE } from "@zcode/shared";
import { GlobeIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";

export function WorkspaceBrowserToggleButton({
  isBrowserOpen,
  onToggleBrowser,
  disabledReason,
  useWindowsCaptionSpacing = false,
}: {
  isBrowserOpen: boolean;
  onToggleBrowser: () => void;
  disabledReason?: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const label = intl.formatMessage({ id: "browser.toggle" });

  if (isOfficeMode) return null;

  return (
    <ControlHintTooltip title={disabledReason ?? label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_BROWSER_TOGGLE}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
          isBrowserOpen && "!bg-selected text-foreground",
        )}
        aria-label={label}
        disabled={Boolean(disabledReason)}
        onClick={() =>
          runUserAction({
            input: {
              featureId: "workbench.browser",
              action: isBrowserOpen ? "close" : "open",
              trigger: "button",
            },
            operation: onToggleBrowser,
            completed: { resultSource: "local_commit" },
            failureStage: "browser_toggle",
          })
        }
      >
        <GlobeIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
