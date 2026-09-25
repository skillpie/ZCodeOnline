// 浏览器隧道管理对话框（specs/web-tunnel.md §5.5 路线 B）：
// 桌面 App 作为 server-cli daemon 的管理面——启用/停用隧道、生成配对链接。
// 实际连接器生命周期与配置文件归 daemon 的 Core 所有；daemon 未运行时给出引导文案。
import { memo, useCallback, useEffect, useState } from "react";
import { Copy, Check, Globe } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { TunnelManagerStatus } from "@zcode/shared";

export const TunnelAccessDialog = memo(function TunnelAccessDialogComponent({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [status, setStatus] = useState<TunnelManagerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayInput, setRelayInput] = useState("");
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!platform.tunnelStatus) return;
    try {
      setStatus(await platform.tunnelStatus());
    } catch (cause) {
      logger.warn("[TunnelAccessDialog] 状态查询失败", { cause });
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [platform]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const t = (id: string): string => intl.formatMessage({ id });

  async function handleEnable(): Promise<void> {
    if (!platform.tunnelEnable || relayInput.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await platform.tunnelEnable(relayInput.trim()));
      setRelayInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(): Promise<void> {
    if (!platform.tunnelDisable) return;
    setBusy(true);
    setError(null);
    setPairingUrl(null);
    try {
      setStatus(await platform.tunnelDisable());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handlePair(): Promise<void> {
    if (!platform.tunnelPair) return;
    setBusy(true);
    setError(null);
    try {
      const pairing = await platform.tunnelPair();
      setPairingUrl(pairing.pairingUrl);
      setPairingCopied(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(): Promise<void> {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setPairingCopied(true);
      setTimeout(() => setPairingCopied(false), 2_000);
    } catch (cause) {
      logger.warn("[TunnelAccessDialog] 复制配对链接失败", { cause });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="size-4 text-foreground-subtle" />
            {t("tunnelManager.title")}
          </DialogTitle>
          <DialogDescription>{t("tunnelManager.description")}</DialogDescription>
        </DialogHeader>

        {status !== null && !status.daemonReachable ? (
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs/relaxed text-foreground-subtle">
            {t("tunnelManager.daemonOffline")}
          </div>
        ) : null}

        {status?.daemonReachable ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs">
              <span className="text-foreground-subtle">{t("tunnelManager.statusLabel")}</span>
              <span className={status.enabled ? "text-foreground" : "text-foreground-subtle"}>
                {status.enabled
                  ? status.connected
                    ? t("tunnelManager.state.connected")
                    : t("tunnelManager.state.enabled")
                  : t("tunnelManager.state.disabled")}
              </span>
            </div>

            {status.enabled ? (
              <>
                <p className="break-all text-ui-xs/relaxed text-foreground-subtle">
                  {t("tunnelManager.relayLabel")}: {status.relayUrl}
                </p>
                {pairingUrl !== null ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                    <span className="truncate text-ui-xs text-foreground">{pairingUrl}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      aria-label={t("tunnelManager.pairing.copy")}
                      onClick={() => void handleCopy()}
                    >
                      {pairingCopied ? (
                        <Check className="size-4 text-emerald-500" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handlePair()}
                  >
                    {t("tunnelManager.pairing.generate")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleDisable()}
                  >
                    {t("tunnelManager.disable")}
                  </Button>
                </div>
                <p className="text-ui-xs/relaxed text-foreground-subtle">
                  {t("tunnelManager.pairing.hint")}
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  value={relayInput}
                  onChange={(event) => setRelayInput(event.target.value)}
                  placeholder={t("tunnelManager.relay.placeholder")}
                  spellCheck={false}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || relayInput.trim().length === 0}
                  className="w-full justify-center"
                  onClick={() => void handleEnable()}
                >
                  {t("tunnelManager.enable")}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {error !== null ? (
          <p className="break-all text-ui-xs/relaxed text-destructive">{error}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
});
