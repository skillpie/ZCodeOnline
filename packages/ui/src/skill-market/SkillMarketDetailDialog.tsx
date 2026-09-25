// SkillPie 技能详情弹窗（ZCode 原生样式）：数据来自市场公开详情接口，
// 免费技能可一键安装到 workspace 所属环境的用户级技能根（specs/skill-market.md §5）。
// 弹窗由 App 宿主按 skillMarketStore.detailSkill 挂载，自身不持久化任何状态。
import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadIcon, HeartIcon, PackageIcon, StoreIcon } from "lucide-react";
import type { SkillMarketSkillDetail } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { useSkillMarketStore } from "@/store/skillMarketStore.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type InstallPhase = "idle" | "installing" | "installed" | "already-installed" | "error";

/**
 * 市场技能约定把触发词附在描述末尾（"……触发词：金山文档、kdocs。"）。
 * 把这段拆出来做成醒目的触发词徽标；解析不出就原样展示完整描述。
 */
export function splitSkillTriggerWords(description: string): {
  text: string;
  triggers: string[];
} {
  const normalized = description.trim();
  // 触发词段约定是描述结尾的一段，且段内不会再出现冒号（排除误匹配正文/URL）。
  const match = /触发词[:：]([^:：]*)$/u.exec(normalized);
  if (!match) {
    return { text: normalized, triggers: [] };
  }
  const text = normalized
    .slice(0, match.index)
    .replace(/[。．.；;!！?？\s]+$/u, "")
    .trim();
  const triggers = match[1]!
    .split(/[、,，;；\n]/u)
    .map((item) => item.replace(/[。．.！!？?\s]+$/u, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  return { text, triggers };
}

export interface SkillMarketDetailDialogProps {
  /** 付费技能引导：打开既有内嵌技能市场视图，深链到该技能详情页。 */
  onOpenSkillMarket?: (normalizedName: string) => void;
}

export function SkillMarketDetailDialog({ onOpenSkillMarket }: SkillMarketDetailDialogProps) {
  const detailSkill = useSkillMarketStore((state) => state.detailSkill);
  const open = detailSkill !== null;
  if (!open) {
    return null;
  }
  return (
    <SkillMarketDetailDialogBody
      key={`${detailSkill.workspaceIdentity?.trim() || detailSkill.workspacePath}|${detailSkill.normalizedName}`}
      onOpenSkillMarket={onOpenSkillMarket}
    />
  );
}

function SkillMarketDetailDialogBody({ onOpenSkillMarket }: SkillMarketDetailDialogProps) {
  const { intl } = useZCodeIntl();
  const detailSkill = useSkillMarketStore((state) => state.detailSkill)!;
  const closeDetail = useSkillMarketStore((state) => state.closeDetail);
  const { services, rpcReady } = useWorkspaceServicesResolution(
    detailSkill.workspacePath,
    null,
    detailSkill.workspaceIdentity,
  );
  const [detail, setDetail] = useState<SkillMarketSkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (!rpcReady) {
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setInstallPhase("idle");
    setInstallError(null);
    services.skillMarketService
      .getSkillDetail({ normalizedName: detailSkill.normalizedName })
      .then((result) => {
        if (!cancelled) {
          setDetail(result);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[SkillMarketDetailDialog] 拉取技能详情失败", { error: message });
        if (!cancelled) {
          setDetailError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detailSkill.normalizedName, rpcReady, services]);

  const handleInstall = useCallback(() => {
    if (!detail || installPhase === "installing") {
      return;
    }
    setInstallPhase("installing");
    setInstallError(null);
    services.skillMarketService
      .installSkill({ normalizedName: detailSkill.normalizedName })
      .then((result) => {
        setInstallPhase(result.status === "already-installed" ? "already-installed" : "installed");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[SkillMarketDetailDialog] 安装技能失败", { error: message });
        setInstallError(message);
        setInstallPhase("error");
      });
  }, [detail, detailSkill.normalizedName, installPhase, services]);

  const handleClose = useCallback(() => {
    closeDetail();
  }, [closeDetail]);

  const isPaid = detail !== null && !detail.isFree;
  // 触发词来自技能作者写在 description 末尾的约定段（如 kdocs-skill）；
  // $token 是本产品的显式引用方式，两者都必须在弹窗里一眼可见。
  const { text: descriptionText, triggers } = useMemo(
    () => (detail ? splitSkillTriggerWords(detail.description) : { text: "", triggers: [] }),
    [detail],
  );

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : handleClose())}>
      <DialogContent className="flex max-h-[80vh] w-full max-w-xl flex-col gap-0 overflow-hidden">
        <DialogHeader className="gap-2 pr-8">
          <DialogTitle className="flex items-center gap-2">
            <StoreIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="truncate">{detail?.name ?? detailSkill.normalizedName}</span>
            {detail?.category ? (
              <span className="rounded-sm bg-muted px-1.5 py-px text-ui-xs font-normal text-foreground-subtle">
                {detail.category}
              </span>
            ) : null}
          </DialogTitle>
          {detail ? (
            <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
              <span className="inline-flex items-center gap-1">
                <DownloadIcon className="size-3" />
                {intl.formatMessage(
                  { id: "skillMarket.detail.downloads" },
                  { count: detail.downloadCount },
                )}
              </span>
              <span className="inline-flex items-center gap-1">
                <HeartIcon className="size-3" />
                {intl.formatMessage(
                  { id: "skillMarket.detail.likes" },
                  { count: detail.likeCount },
                )}
              </span>
              {detail.version ? (
                <span className="inline-flex items-center gap-1">
                  <PackageIcon className="size-3" />
                  {intl.formatMessage(
                    { id: "skillMarket.detail.version" },
                    { version: detail.version.versionNo },
                  )}
                </span>
              ) : null}
              <span>{detail.ownerDisplayName}</span>
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {detailError ? (
            <p className="text-ui-sm text-destructive">{detailError}</p>
          ) : detail === null ? (
            <p className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "skillMarket.detail.loading" })}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {/* 触发方式是弹窗的第一信息：显式 $token 引用 + 作者声明的自然语言触发词。 */}
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/60 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "skillMarket.detail.invoke" })}
                  </span>
                  <code className="rounded-sm bg-background px-1.5 py-0.5 font-mono text-ui-sm font-medium text-foreground">
                    ${detail.normalizedName}
                  </code>
                </div>
                {triggers.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="shrink-0 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "skillMarket.detail.triggers" })}
                    </span>
                    {triggers.map((trigger) => (
                      <span
                        key={trigger}
                        className="rounded-sm bg-background px-1.5 py-0.5 text-ui-sm text-foreground"
                      >
                        {trigger}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {descriptionText ? (
                <p className="text-ui-sm/relaxed text-foreground-subtle">{descriptionText}</p>
              ) : null}
              {detail.screenshots.length > 0 ? (
                <div className="flex snap-x gap-2 overflow-x-auto pb-1">
                  {detail.screenshots
                    .filter((url) => url.startsWith("https://"))
                    .map((url) => (
                      <img
                        key={url}
                        src={url}
                        alt=""
                        loading="lazy"
                        className="h-40 w-auto rounded-md border border-border object-cover"
                      />
                    ))}
                </div>
              ) : null}
              {detail.usageInstructions ? (
                <MessageResponse
                  className={cn(
                    "prose prose-sm max-w-none text-ui-sm leading-relaxed text-foreground dark:prose-invert",
                    "prose-headings:font-semibold prose-headings:tracking-tight",
                    "prose-h1:text-ui-base prose-h2:text-ui-sm prose-h3:text-ui-sm",
                  )}
                >
                  {detail.usageInstructions}
                </MessageResponse>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className="mt-4 items-center gap-2">
          {installPhase === "error" && installError ? (
            <span className="min-w-0 flex-1 truncate text-ui-sm text-destructive">
              {installError}
            </span>
          ) : installPhase === "installed" ? (
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "skillMarket.detail.installed" })}
            </span>
          ) : installPhase === "already-installed" ? (
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "skillMarket.detail.alreadyInstalled" })}
            </span>
          ) : isPaid ? (
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "skillMarket.detail.paidHint" })}
            </span>
          ) : null}
          {isPaid && onOpenSkillMarket ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                handleClose();
                onOpenSkillMarket(detailSkill.normalizedName);
              }}
            >
              {intl.formatMessage({ id: "skillMarket.detail.openMarket" })}
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={handleInstall}
            disabled={
              detail === null || detailError !== null || isPaid || installPhase === "installing"
            }
          >
            {installPhase === "installing"
              ? intl.formatMessage({ id: "skillMarket.detail.installing" })
              : intl.formatMessage({ id: "skillMarket.detail.install" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
