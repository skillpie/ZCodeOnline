// 连接引导卡片（specs/web-tunnel.md）：受控组件——状态与回调由 TunnelAppRoot 持有，
// 作为不可关闭的顶层模态内容渲染（仅定局失败/需要用户操作时弹出，平时不遮挡真实主界面）。
// 未挂 ZCodeIntlProvider，与 WebBootstrapErrorScreen 同样用 navigator.language 内联双语。
import { useState } from "react";
import {
  detectDesktopDownloadPlatform,
  resolveDesktopDownloadUrl,
  type DesktopDownloadPlatform,
} from "@zcode/shared";
import {
  AGENT_INSTALL_URL,
  detectTunnelInstallPlatform,
  tunnelInstallCommands,
  type TunnelInstallCommand,
} from "./tunnelInstall.js";

type GateStatus = "idle" | "pairing" | "connecting" | "disconnected";

const zh = (): boolean => /^zh\b/i.test(navigator.language);

// UA 在页面生命周期内不变：平台 → 安装命令的映射按模块级求值一次即可。
const INSTALL_COMMANDS = tunnelInstallCommands(detectTunnelInstallPlatform(navigator.userAgent));

/** 单条安装命令行：等宽展示 + 复制按钮（specs/web-tunnel.md §5.7）。 */
function InstallCommandRow({
  item,
  isZh,
  label,
}: {
  item: TunnelInstallCommand;
  isZh: boolean;
  /** 行首说明文字；缺省用命令的目标 shell 名（POSIX 单命令无标签）。 */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const shellLabel = label ?? item.shell;
  return (
    <div className="flex items-center gap-2 py-1">
      {shellLabel !== null && shellLabel !== undefined ? (
        // shell 标签固定宽对齐两条命令；自定义标签（Agent 行）自适应宽度。
        <span
          className={`shrink-0 text-ui-sm text-foreground-subtle ${label === undefined ? "w-20" : ""}`}
        >
          {shellLabel}
        </span>
      ) : null}
      <code className="flex-1 overflow-x-auto whitespace-nowrap text-ui-base text-foreground">
        {item.command}
      </code>
      <button
        type="button"
        className="shrink-0 text-ui-base text-foreground-subtle hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(item.command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          });
        }}
      >
        {copied ? (isZh ? "已复制" : "Copied") : isZh ? "复制" : "Copy"}
      </button>
    </div>
  );
}

/** 桌面版安装包直链行：两个平台并列，与侧栏「下载桌面版」弹窗共用同一组固定文件名。 */
function DesktopDownloadRow({ isZh }: { isZh: boolean }) {
  // 门禁卡片只在浏览器渲染，origin 取当前站点；链接是安装包直链，浏览器原生触发下载。
  const entries: Array<{ platform: DesktopDownloadPlatform; label: string }> = [
    { platform: "mac", label: isZh ? "Mac 版（dmg）" : "Mac (.dmg)" },
    { platform: "windows", label: isZh ? "Windows 版（exe）" : "Windows (.exe)" },
  ];
  const recommended = detectDesktopDownloadPlatform(navigator.userAgent);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2">
      <span className="text-ui-sm text-foreground-subtle">
        {isZh ? "偏好图形界面？下载桌面版：" : "Prefer a GUI? Download the desktop app:"}
      </span>
      {entries.map(({ platform, label }) => (
        <a
          key={platform}
          href={resolveDesktopDownloadUrl(platform, window.location.origin)}
          className="text-ui-sm text-foreground underline underline-offset-2 hover:text-foreground-subtle"
          data-testid={`gate-desktop-download-${platform}`}
        >
          {label}
          {recommended === platform ? (isZh ? "（推荐）" : " (recommended)") : ""}
        </a>
      ))}
    </div>
  );
}

/** 未配对时展示的安装引导（specs/web-tunnel.md §5.7）：按平台给出对应一键命令 + Agent 代装入口。 */
function InstallGuide({ isZh }: { isZh: boolean }) {
  // 默认展开：需要安装的用户第一眼就能看到命令，少一次点击。
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-4 rounded-lg border border-border bg-surface">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-ui-base text-foreground-subtle hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {isZh ? "还没有安装？一行命令装好本机端" : "Not installed yet? One-line local install"}
        <span className="text-foreground-subtle">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2">
          {INSTALL_COMMANDS.map((item) => (
            <InstallCommandRow key={item.command} item={item} isZh={isZh} />
          ))}
          <div className="mt-1 border-t border-border pt-2">
            <InstallCommandRow
              item={{ shell: null, command: AGENT_INSTALL_URL }}
              isZh={isZh}
              label={isZh ? "发给 AI 助手代装" : "Or let an AI agent install"}
            />
          </div>
          <div className="mt-1">
            <DesktopDownloadRow isZh={isZh} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface ConnectionGateCardProps {
  status: GateStatus;
  error: string | null;
  needsLogin: boolean;
  onReconnect: () => void;
  onStartLogin: () => void;
}

export function ConnectionGateCard(props: ConnectionGateCardProps) {
  const isZh = zh();
  const busy = props.status === "pairing" || props.status === "connecting";
  const t = (zhText: string, enText: string) => (isZh ? zhText : enText);

  return (
    <section className="w-full rounded-xl border border-card-border bg-card p-5 shadow-xl">
      <div className="flex items-center gap-3">
        <span
          className={`size-2 rounded-full ${
            props.status === "connecting" ? "animate-pulse bg-amber-500" : "bg-emerald-500"
          }`}
        />
        <h1 className="text-ui-lg font-medium">{t("连接到你的电脑", "Connect to your machine")}</h1>
      </div>
      <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
        {t(
          "本机已安装时会自动连接（无需操作）。连接其他电脑：在该电脑上运行 zcode serve，打开它打印的远程链接。",
          "Auto-connects when installed on this machine. To reach another computer: run zcode serve there and open the link it prints.",
        )}
      </p>

      <InstallGuide isZh={isZh} />

      {props.needsLogin ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="text-ui-base/relaxed text-foreground-subtle">
            {t("配对前需要登录 ZCode 账号。", "Sign in to your ZCode account first.")}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground hover:bg-surface-hover"
            onClick={props.onStartLogin}
          >
            {t("登录", "Sign in")}
          </button>
        </div>
      ) : null}

      {props.status === "connecting" ? (
        <p className="mt-3 text-ui-base/relaxed text-foreground-subtle">
          {t("正在建立端到端连接…", "Establishing end-to-end connection…")}
        </p>
      ) : null}
      {props.status === "disconnected" ? (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {t("连接已断开。", "Connection closed.")}
          </p>
          <button
            type="button"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-center text-ui-base text-foreground hover:bg-surface-hover"
            onClick={props.onReconnect}
          >
            {t("重新连接", "Reconnect")}
          </button>
        </div>
      ) : null}
      {props.error !== null ? (
        <p className="mt-3 break-all text-ui-base/relaxed text-destructive">{props.error}</p>
      ) : null}
    </section>
  );
}
