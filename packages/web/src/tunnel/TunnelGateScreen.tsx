// 连接引导卡片（specs/web-tunnel.md）：受控组件——状态与回调由 TunnelAppRoot 持有，
// 作为不可关闭的顶层模态内容渲染（未连接时盖在常驻主界面上）。
// 未挂 ZCodeIntlProvider，与 WebBootstrapErrorScreen 同样用 navigator.language 内联双语。
import { useState } from "react";

type GateStatus = "idle" | "pairing" | "connecting" | "disconnected";

const zh = (): boolean => /^zh\b/i.test(navigator.language);

const INSTALL_COMMAND = "curl -fsSL https://zcode.skillpie.cn/install.sh | sh";

/** 未配对时展示的安装引导（specs/web-tunnel.md §5.7）：一行 curl 装好本机端。 */
function InstallGuide({ isZh }: { isZh: boolean }) {
  // 默认展开：需要安装的用户第一眼就能看到命令，少一次点击。
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-lg border border-border bg-surface">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-ui-xs text-foreground-subtle hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {isZh ? "还没有安装？一行命令装好本机端" : "Not installed yet? One-line local install"}
        <span className="text-foreground-subtle">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap text-ui-xs text-foreground">
            {INSTALL_COMMAND}
          </code>
          <button
            type="button"
            className="shrink-0 text-ui-xs text-foreground-subtle hover:text-foreground"
            onClick={() => {
              void navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2_000);
              });
            }}
          >
            {copied ? (isZh ? "已复制" : "Copied") : isZh ? "复制" : "Copy"}
          </button>
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
        <h1 className="text-ui-xs font-medium">{t("连接到你的电脑", "Connect to your machine")}</h1>
      </div>
      <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">
        {t(
          "本机已安装时会自动连接（无需操作）。连接其他电脑：在该电脑上运行 zcode serve，打开它打印的远程链接。",
          "Auto-connects when installed on this machine. To reach another computer: run zcode serve there and open the link it prints.",
        )}
      </p>

      <InstallGuide isZh={isZh} />

      {props.needsLogin ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="text-ui-xs/relaxed text-foreground-subtle">
            {t("配对前需要登录 ZCode 账号。", "Sign in to your ZCode account first.")}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground hover:bg-surface-hover"
            onClick={props.onStartLogin}
          >
            {t("登录", "Sign in")}
          </button>
        </div>
      ) : null}

      {props.status === "connecting" ? (
        <p className="mt-3 text-ui-xs/relaxed text-foreground-subtle">
          {t("正在建立端到端连接…", "Establishing end-to-end connection…")}
        </p>
      ) : null}
      {props.status === "disconnected" ? (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-ui-xs/relaxed text-foreground-subtle">
            {t("连接已断开。", "Connection closed.")}
          </p>
          <button
            type="button"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-center text-ui-xs text-foreground hover:bg-surface-hover"
            onClick={props.onReconnect}
          >
            {t("重新连接", "Reconnect")}
          </button>
        </div>
      ) : null}
      {props.error !== null ? (
        <p className="mt-3 break-all text-ui-xs/relaxed text-destructive">{props.error}</p>
      ) : null}
    </section>
  );
}
