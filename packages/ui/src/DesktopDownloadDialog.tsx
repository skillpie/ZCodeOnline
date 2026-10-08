// 「安装桌面版」弹窗：两个整卡选项分别打开站点上传的 Mac/Windows 安装包。
// 链接解析与 UA 推荐逻辑在 @zcode/shared desktopDownload，本组件只负责展示与跳转。
import { Apple, LayoutGrid, MonitorDown } from "lucide-react";
import {
  detectDesktopDownloadPlatform,
  resolveDefaultDesktopDownloadSiteOrigin,
  resolveDesktopDownloadUrl,
  type DesktopDownloadPlatform,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";

const PLATFORM_OPTIONS: Array<{
  platform: DesktopDownloadPlatform;
  labelId: string;
  hintId: string;
  testId: string;
}> = [
  {
    platform: "mac",
    labelId: "sidebar.desktopDownload.mac",
    hintId: "sidebar.desktopDownload.macHint",
    testId: "sidebar-desktop-download-mac",
  },
  {
    platform: "windows",
    labelId: "sidebar.desktopDownload.windows",
    hintId: "sidebar.desktopDownload.windowsHint",
    testId: "sidebar-desktop-download-windows",
  },
];

function PlatformIcon({ platform }: { platform: DesktopDownloadPlatform }) {
  // lucide 没有系统品牌图标集：Mac 用 Apple 字形，Windows 借四宫格近似徽标。
  return platform === "mac" ? (
    <Apple className="size-5 shrink-0" />
  ) : (
    <LayoutGrid className="size-5 shrink-0" />
  );
}

export function DesktopDownloadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();

  const handleSelect = (target: DesktopDownloadPlatform) => {
    const origin =
      typeof window === "undefined" || !window.location.origin
        ? resolveDefaultDesktopDownloadSiteOrigin()
        : window.location.origin;
    platform.openExternal(resolveDesktopDownloadUrl(target, origin));
    onOpenChange(false);
  };

  // 推荐标记只在弹窗打开时按当前 UA 计算一次即可，不随渲染抖动。
  const recommended = open ? detectDesktopDownloadPlatform(window.navigator.userAgent) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-4 sm:max-w-sm">
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
            <MonitorDown className="size-5" />
            {intl.formatMessage({ id: "sidebar.desktopDownload.dialogTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "sidebar.desktopDownload.dialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {PLATFORM_OPTIONS.map(({ platform: target, labelId, hintId, testId }) => (
            <button
              key={target}
              type="button"
              data-testid={testId}
              onClick={() => handleSelect(target)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                // 推荐项与 AssistMachineRowCard 当前卡同款高亮：品牌色边框 + accent 背景。
                recommended === target
                  ? "border-brand bg-accent"
                  : "border-border bg-surface hover:border-input-border-focused hover:bg-surface-hover/40",
              )}
            >
              <PlatformIcon platform={target} />
              <span className="min-w-0 flex-1">
                <span className="block text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: labelId })}
                </span>
                <span className="block text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: hintId })}
                </span>
              </span>
              {recommended === target ? (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-primary/40 bg-accent px-2 text-ui-xs font-medium leading-none text-primary">
                  {intl.formatMessage({ id: "sidebar.desktopDownload.recommended" })}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
