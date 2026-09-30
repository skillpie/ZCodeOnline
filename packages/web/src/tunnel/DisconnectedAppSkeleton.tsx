// 未连接时的静态应用骨架：镜像真实主界面空态（264px 侧栏、品牌问候 + 输入卡），
// 视觉占位而非假交互；清单条与品牌 Logo 均为静态占位，不模拟可点元素。
// 骨架未挂 ZCodeIntlProvider，文案按 navigator.language 内联双语（同 TunnelGateScreen）。
import { ZCodeEmptyStateLogo } from "@zcode/ui";

/** 与 ConversationDraftEmptyState 的 GREETING_BOUNDARY_HOURS（5/9/12/14/18/23）保持一致。 */
function skeletonGreeting(now: Date): { zh: string; en: string } {
  const hour = now.getHours();
  if (hour >= 5 && hour < 9) {
    return { zh: "早上好呀，新的一天开始啦", en: "Morning, ready when you are" };
  }
  if (hour >= 9 && hour < 12) {
    return { zh: "上午好呀，有什么想让我帮忙的吗", en: "Morning, how can I help?" };
  }
  if (hour >= 12 && hour < 14) {
    return { zh: "中午好呀，要不要先休息一下", en: "Noon break?" };
  }
  if (hour >= 14 && hour < 18) {
    return { zh: "下午好呀，接下来交给我吧", en: "Good afternoon! Leave the rest to me." };
  }
  if (hour >= 18 && hour < 23) {
    return { zh: "晚上好呀，今天辛苦啦", en: "Evening, nice work today" };
  }
  return { zh: "夜深啦，别忘了照顾好自己哦", en: "It's late—remember to take care of yourself." };
}

function SkeletonIcon({ path }: { path: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d={path} />
    </svg>
  );
}

const SKELETON_ICONS = {
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z",
  automations: "M12 8v4l2.5 2.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  pluginMarket:
    "M20 7H4m16 0l-1.5 12.5a2 2 0 01-2 1.5h-9a2 2 0 01-2-1.5L4 7m4 0V5a2 2 0 012-2h4a2 2 0 012 2v2",
  skillMarket: "M12 3l1.9 5.6H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.6h6.1z",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
  hash: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  chevronDown: "M6 9l6 6 6-6",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
} as const;

function SkeletonNavRow({
  icon,
  label,
  shortcut,
}: {
  icon: keyof typeof SKELETON_ICONS;
  label: string;
  shortcut?: string;
}) {
  return (
    <div className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-ui-sm text-foreground">
      <span className="text-foreground-subtle">
        <SkeletonIcon path={SKELETON_ICONS[icon]} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <span className="shrink-0 text-ui-xs font-normal text-foreground-subtlest">{shortcut}</span>
      ) : null}
    </div>
  );
}

/** 变宽占位条：模拟清单文字，长度抖动避免节奏单一。 */
function SkeletonBar({
  widthPercent,
  className = "h-3",
}: {
  widthPercent: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full bg-surface ${className}`}
      style={{ width: `${widthPercent}%` }}
    />
  );
}

export function DisconnectedAppSkeleton() {
  const isZh = /^zh\b/i.test(navigator.language);
  const t = (zhText: string, enText: string) => (isZh ? zhText : enText);
  const greeting = skeletonGreeting(new Date());
  // 快捷键提示按平台显示（同真实侧栏 ⌘/Ctrl 的平台区分）。
  const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  const modKey = isApplePlatform ? "⌘" : "Ctrl+";
  return (
    <div className="flex h-full w-full select-none bg-background text-foreground" aria-hidden>
      {/* 侧栏占位：与 WorkspaceShellLayout 默认 264px 同宽。 */}
      <aside className="hidden w-[264px] shrink-0 flex-col border-r border-border md:flex">
        <div className="h-12" />
        <div className="flex flex-col gap-1 px-2 pb-3">
          <SkeletonNavRow icon="plus" label={t("新建任务", "New task")} shortcut={`${modKey}N`} />
          <SkeletonNavRow icon="search" label={t("搜索", "Search")} shortcut={`${modKey}H`} />
          <SkeletonNavRow icon="automations" label={t("自动化", "Automations")} />
          <SkeletonNavRow icon="pluginMarket" label={t("插件市场", "Plugin market")} />
          <SkeletonNavRow icon="skillMarket" label={t("技能市场", "Skill market")} />
        </div>
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <span className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            <SkeletonIcon path={SKELETON_ICONS.hash} />
            {t("分组", "Group")}
          </span>
          <span className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            <SkeletonIcon path={SKELETON_ICONS.folder} />
            {t("项目", "Projects")}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-3">
          <div className="pb-1 text-ui-xs font-medium text-foreground-subtle">
            {t("项目", "Projects")}
          </div>
          {[0, 1, 2].map((project) => (
            <div key={project} className="pb-2">
              <div className="flex items-center gap-2 py-1 text-foreground-subtle">
                <SkeletonIcon path={SKELETON_ICONS.folder} />
                <SkeletonBar widthPercent={34 - (project % 3) * 4} className="h-2.5" />
              </div>
              <div className="flex flex-col gap-1 pl-5">
                {[0, 1].map((task) => (
                  <div key={task} className="flex items-center gap-2 py-0.5">
                    <SkeletonBar widthPercent={52 - ((project + task) % 3) * 6} className="h-2.5" />
                    <span className="ml-auto inline-block h-2.5 w-7 shrink-0 rounded-full bg-surface" />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="pb-1 pt-3 text-ui-xs font-medium text-foreground-subtle">
            {t("任务", "Tasks")}
          </div>
          <div className="pl-1 text-ui-xs text-foreground-subtlest">
            {t("还没有任务", "No tasks yet")}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
          <span className="size-7 shrink-0 rounded-full bg-surface" />
          <SkeletonBar widthPercent={18} className="h-2.5" />
          <span className="inline-block h-4 w-8 shrink-0 rounded-full bg-surface" />
          <span className="ml-auto flex items-center gap-1.5 text-foreground-subtlest">
            {[0, 1, 2].map((icon) => (
              <span key={icon} className="size-4 rounded bg-surface" />
            ))}
          </span>
        </div>
      </aside>
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6">
        {/* 品牌 Logo 水印：复用真实空态的 ZCodeEmptyStateLogo（浅色线框渐隐 + 深色资源）。 */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10 -translate-x-1/2 -translate-y-1/2 text-foreground-subtlest">
          <ZCodeEmptyStateLogo className="h-full w-full" />
        </div>
        {/* 间距对齐真实空态容器（gap-6 + 渐变线 -mt-3 的组合）。 */}
        <div className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-6">
          <p className="w-full px-4 text-center text-3xl/[1.2] font-medium text-foreground">
            {isZh ? greeting.zh : greeting.en}
          </p>
          {/* 问候语下的品牌渐变细线（ConversationDraftEmptyState 同款）。 */}
          <div className="-mt-3 h-1 w-12 shrink-0 rounded-full bg-brand-gradient" />
          {/* 输入卡占位：工作区选择行 + 提问占位文案 + 工具条（右侧黑色发送圆钮）。 */}
          <div className="mt-8 w-full rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-ui-sm text-foreground-subtle">
              <SkeletonIcon path={SKELETON_ICONS.folder} />
              <SkeletonBar widthPercent={16} className="h-2.5" />
              <SkeletonIcon path={SKELETON_ICONS.chevronDown} />
            </div>
            <div className="px-4 pb-6 pt-3.5 text-ui-base text-foreground-subtlest">
              {t(
                "向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力",
                "Ask ZCode — @ for context, / for commands",
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pb-3">
              <span className="flex size-7 items-center justify-center rounded-lg text-foreground-subtle">
                <SkeletonIcon path={SKELETON_ICONS.plus} />
              </span>
              <span className="h-7 w-20 rounded-full border border-border" />
              <span className="h-7 w-14 rounded-full border border-border" />
              <span className="ml-auto h-7 w-20 rounded-full border border-border" />
              <span className="h-7 w-14 rounded-full border border-border" />
              <span className="flex size-7 items-center justify-center rounded-full bg-foreground text-background">
                <SkeletonIcon path={SKELETON_ICONS.arrowUp} />
              </span>
            </div>
          </div>
          {/* 快捷能力 chips 占位。 */}
          <div className="mt-4 flex items-center gap-2">
            {[80, 64, 88, 64].map((chipWidth, chip) => (
              <span
                key={chip}
                className="flex h-8 items-center justify-center rounded-lg border border-border bg-card"
                style={{ width: `${chipWidth}px` }}
              >
                <span className="inline-block h-2.5 w-2/3 rounded-full bg-surface" />
              </span>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
