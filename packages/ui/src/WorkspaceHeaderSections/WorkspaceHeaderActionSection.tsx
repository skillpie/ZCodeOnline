import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { WorkspaceBrowserToggleButton } from "@/WorkspaceBrowserToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { WorkspaceHeaderGitTools } from "@/WorkspaceHeaderGitTools.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  isBrowserOpen,
  onToggleBrowser,
  supportsEmbeddedBrowser,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
  gitSummary,
  gitDirtyFileCount = 0,
  activeTaskChangeSummary,
  onRefreshGit,
}: WorkspaceHeaderActionSectionProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* Git 常驻工具组（更改 / 分支 / 提交）位于分享按钮左侧；远程移动端头部过窄，
          与终端入口同规则整体隐藏，非 Git 工作区由组件自身返回 null。 */}
      {!simplifyForNarrowRemote && gitSummary && onRefreshGit ? (
        <WorkspaceHeaderGitTools
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          gitSummary={gitSummary}
          gitDirtyFileCount={gitDirtyFileCount}
          activeTaskChangeSummary={activeTaskChangeSummary}
          onRefreshGit={onRefreshGit}
        />
      ) : null}
      {/* 分享发布接口依赖登录态；未登录时隐藏入口，避免用户打开后只能得到鉴权失败。 */}
      {activeTaskId && user && isDesktop !== false ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {!simplifyForNarrowRemote ? (
        <>
          {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* 浏览器快捷入口在终端按钮左侧；Web/移动端不支持内嵌浏览器，随终端入口同规则整体隐藏。*/}
          {supportsEmbeddedBrowser ? (
            <WorkspaceBrowserToggleButton
              isBrowserOpen={isBrowserOpen}
              onToggleBrowser={onToggleBrowser}
              disabledReason={readOnlyReason}
              useWindowsCaptionSpacing={useWindowsCaptionSpacing}
            />
          ) : null}
          {/* 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。*/}
          <WorkspaceTerminalToggleButton
            isTerminalOpen={isTerminalOpen}
            onToggleTerminal={onToggleTerminal}
            disabledReason={readOnlyReason}
            useWindowsCaptionSpacing={useWindowsCaptionSpacing}
          />
        </>
      ) : null}
      {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
