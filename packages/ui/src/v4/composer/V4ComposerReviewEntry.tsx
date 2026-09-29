/**
 * 评审模式常驻入口（composer「评审」开关，默认关闭）。
 *
 * 开关是会话级草稿事实，由 SessionPane 经草稿 scope 持久化，提交时冻结进本次
 * Submission 并按轮透传；Agent 侧对开启评审的输入注入 review_mode 系统提醒
 * （先对方案做拷问式评审、达成共识再实现），关闭即恢复默认行为。
 *
 * 纯展示件：不依赖平台/服务可用性，任何能渲染 composer 的宿主都可使用。
 * 折叠语义与数据源入口同档（collapse priority 1）：窄容器只保留开关本体。
 */
import { memo } from "react";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

interface V4ComposerReviewEntryProps {
  /** 当前会话的评审开关；false = 关闭（默认态）。 */
  reviewEnabled: boolean;
  /** 开关回调；关闭是显式事实，必须以 false 回调（不能靠缺省）。 */
  onSetReviewEnabled: (reviewEnabled: boolean) => void;
}

function ReviewEntryInner({ reviewEnabled, onSetReviewEnabled }: V4ComposerReviewEntryProps) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "chat.toolbar.review.label" });

  return (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.toolbar.review.tooltip" })}>
      <div
        data-testid="composer-review-entry"
        data-composer-collapse-priority="1"
        data-review-enabled={reviewEnabled ? "true" : "false"}
        className={cn(
          "group/review flex h-7 w-fit cursor-pointer items-center gap-1.5 rounded-lg px-1",
          "data-[composer-compact=true]:w-7 data-[composer-compact=true]:justify-center data-[composer-compact=true]:px-0",
        )}
      >
        <Switch
          size="sm"
          checked={reviewEnabled}
          onCheckedChange={onSetReviewEnabled}
          aria-label={label}
          data-testid="composer-review-switch"
        />
        <span
          className={cn(
            "inline-flex whitespace-nowrap text-ui-base",
            reviewEnabled ? "text-foreground" : "text-foreground-subtle",
            "group-data-[composer-compact=true]/review:hidden",
          )}
          data-review-label
        >
          {label}
        </span>
      </div>
    </ControlHintTooltip>
  );
}

export const V4ComposerReviewEntry = memo(ReviewEntryInner);
