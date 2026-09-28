// 远程码入口（specs/web-tunnel.md §5.9）：Web 版侧栏设置按钮左侧的图标按钮。
// 点击先弹「我的远程码」弹窗，展示当前带码的完整链接并附「复制」「刷新」；
// 「刷新」需二次确认（旧码及已分享链接立即失效、不可恢复），确认后轮换宿主码并
// 原地更新为新链接。当前码以宿主回环发现端点为权威，取不到时回退本地存储码。
// 仅当 platform 实现了远程码契约（浏览器与宿主同机的 Web 端）时渲染；
// 轮换的权威所有者在宿主 Core 的隧道运行时，这里只经平台契约触发。
import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { formatAssistCode } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type AssistDialogPhase = "loading" | "ready" | "confirm" | "refreshing" | "error";

export function WorkspaceAssistCodeRefreshTrigger({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<AssistDialogPhase>("loading");
  const [code, setCode] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const [copied, setCopied] = useState(false);

  // 桌面端走 daemon 控制链路（暂未暴露远程码契约），未实现的平台直接不渲染入口。
  if (typeof platform.refreshRemoteAssistCode !== "function") {
    return null;
  }

  const getRemoteAssistCode = platform.getRemoteAssistCode?.bind(platform);
  const refreshRemoteAssistCode = platform.refreshRemoteAssistCode.bind(platform);
  const shareUrl = code === null ? null : `${window.location.origin}/${code}`;

  const loadCurrentCode = () => {
    if (!getRemoteAssistCode) return;
    setPhase("loading");
    setErrorCode(null);
    // 平台实现内部已做"宿主不可达 → 回退本地存储码"的兜底，这里只区分成功/失败。
    void getRemoteAssistCode()
      .then((result) => {
        setCode(result.code);
        setPhase("ready");
      })
      .catch((cause: unknown) => {
        logger.warn("[WorkspaceAssistCodeRefreshTrigger] 读取远程码失败", {
          message: cause instanceof Error ? cause.message : String(cause),
        });
        setErrorCode(cause instanceof Error ? cause.message : String(cause));
        setPhase("error");
      });
  };

  const resetAndOpen = () => {
    setCode(null);
    setRotated(false);
    setCopied(false);
    setOpen(true);
    loadCurrentCode();
  };

  const runRefresh = () => {
    setPhase("refreshing");
    setErrorCode(null);
    void refreshRemoteAssistCode()
      .then((result) => {
        setCode(result.code);
        setRotated(true);
        setCopied(false);
        setPhase("ready");
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[WorkspaceAssistCodeRefreshTrigger] 刷新远程码失败", { message });
        setErrorCode(message);
        setPhase("error");
      });
  };

  const copyShareUrl = () => {
    if (shareUrl === null) return;
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  };

  return (
    <>
      <ControlHintTooltip title={intl.formatMessage({ id: "assistCode.dialog.trigger" })}>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={intl.formatMessage({ id: "assistCode.dialog.trigger" })}
          className={cn("text-foreground hover:bg-surface-hover hover:text-foreground", className)}
          onClick={resetAndOpen}
        >
          <KeyRound className="size-4" />
        </Button>
      </ControlHintTooltip>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          // 刷新进行中不允许误关：Esc/遮罩只在工作完成或未开始时可关闭。
          if (phase === "refreshing") return;
          setOpen(nextOpen);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100vh-6rem)] gap-5 overflow-y-auto rounded-2xl sm:max-w-md"
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "assistCode.dialog.title" })}
            </DialogTitle>
            <DialogDescription className="pt-0.5 text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({ id: "assistCode.dialog.description" })}
            </DialogDescription>
          </DialogHeader>

          {phase === "confirm" ? (
            <p className="text-ui-base/relaxed text-foreground">
              {intl.formatMessage({ id: "assistCode.dialog.refreshWarning" })}
            </p>
          ) : null}

          {phase === "ready" || phase === "confirm" || phase === "refreshing" ? (
            <div className="space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5">
              {rotated && phase === "ready" ? (
                <div className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "assistCode.dialog.refreshed" })}
                </div>
              ) : null}
              <div className="text-ui-base font-medium tracking-widest text-foreground">
                {code === null ? null : formatAssistCode(code)}
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-ui-xs text-foreground-subtle">
                  {shareUrl}
                </code>
                {phase === "ready" ? (
                  <>
                    <button
                      type="button"
                      className="shrink-0 text-ui-xs text-foreground-subtle hover:text-foreground"
                      onClick={copyShareUrl}
                    >
                      {copied
                        ? intl.formatMessage({ id: "assistCode.dialog.copied" })
                        : intl.formatMessage({ id: "assistCode.dialog.copy" })}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-ui-xs text-primary hover:text-primary"
                      onClick={() => setPhase("confirm")}
                    >
                      {intl.formatMessage({ id: "assistCode.dialog.refresh" })}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {phase === "loading" ? (
            <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" />
              {intl.formatMessage({ id: "assistCode.dialog.loading" })}
            </div>
          ) : null}

          {phase === "error" ? (
            <p className="break-all text-ui-base/relaxed text-destructive">{errorCode}</p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-end">
            {phase === "confirm" ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="h-9 gap-3 px-4 justify-between sm:min-w-28"
                  onClick={() => setPhase("ready")}
                >
                  <span>{intl.formatMessage({ id: "common.cancel" })}</span>
                  <span className="font-mono text-ui-base text-foreground-subtle">esc</span>
                </Button>
                <Button
                  type="button"
                  autoFocus
                  size="lg"
                  className="h-9 gap-3 px-4 justify-between sm:min-w-32"
                  onClick={runRefresh}
                >
                  <span>{intl.formatMessage({ id: "assistCode.dialog.refreshConfirm" })}</span>
                  <span className="font-mono text-ui-base text-primary-foreground/60">⏎</span>
                </Button>
              </>
            ) : null}
            {phase === "refreshing" ? (
              <Button type="button" size="lg" disabled className="h-9 gap-2 px-4">
                <Loader2 className="size-4 animate-spin" />
                {intl.formatMessage({ id: "assistCode.dialog.refreshing" })}
              </Button>
            ) : null}
            {phase === "error" ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="h-9 px-4"
                  onClick={() => setOpen(false)}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </Button>
                <Button
                  type="button"
                  autoFocus
                  size="lg"
                  className="h-9 px-4"
                  onClick={() => {
                    // 读取失败的重试回到加载；刷新失败的重试原地再刷新。
                    if (code === null) loadCurrentCode();
                    else runRefresh();
                  }}
                >
                  {intl.formatMessage({ id: "assistCode.dialog.retry" })}
                </Button>
              </>
            ) : null}
            {phase === "ready" || phase === "loading" ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className={cn("h-9 px-4", phase === "ready" && "justify-between sm:min-w-28")}
                onClick={() => setOpen(false)}
              >
                <span>{intl.formatMessage({ id: "common.close" })}</span>
                {phase === "ready" ? (
                  <span className="font-mono text-ui-base text-foreground-subtle">esc</span>
                ) : null}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
