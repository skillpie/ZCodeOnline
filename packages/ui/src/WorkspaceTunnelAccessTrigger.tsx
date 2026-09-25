import { useState } from "react";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TunnelAccessDialog } from "@/TunnelAccessDialog.js";

export function WorkspaceTunnelAccessTrigger({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "tunnelManager.trigger" })}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => setOpen(true)}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "tunnelManager.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          <Globe className="size-4 text-foreground-subtle" />
          {compact ? (
            <span className="sr-only">{intl.formatMessage({ id: "tunnelManager.trigger" })}</span>
          ) : (
            intl.formatMessage({ id: "tunnelManager.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <TunnelAccessDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
