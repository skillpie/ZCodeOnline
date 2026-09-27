import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getWorkspaceConversationPromptAvailability,
  requestWorkspaceConversationPrompt,
  subscribeWorkspaceConversationPromptRuntime,
  type WorkspaceConversationPromptScope,
} from "@/lib/workspaceConversationPromptRuntime.js";

/** 非当前分支是「合并」（合入当前分支），当前分支是「拉取」（同步远程更新）。 */
type GitBranchConversationActionKind = "merge" | "pull";

interface GitBranchConversationActionProps {
  kind: GitBranchConversationActionKind;
  branchName: string;
  scope: WorkspaceConversationPromptScope;
  mutationPending: boolean;
  /** 先于发送调用，用于关闭分支弹层。 */
  onTriggered: () => void;
}

const ACTION_MESSAGE_IDS = {
  merge: {
    action: "git.branchSwitcher.mergeAction",
    aria: "git.branchSwitcher.mergeAction.ariaLabel",
    prompt: "git.branchSwitcher.mergePrompt",
  },
  pull: {
    action: "git.branchSwitcher.pullAction",
    aria: "git.branchSwitcher.pullAction.ariaLabel",
    prompt: "git.branchSwitcher.pullPrompt",
  },
} as const;

/**
 * 分支行行尾的对话动作：把提示词交给当前工作区主对话执行，不切换分支。
 * 挂载时机由父级按 hover / focus-within / 触屏常显决定，未交互时不渲染、不占布局。
 * 主 pane 未挂载（发送能力未注册）时同样渲染为 null，避免死入口。
 */
export function GitBranchConversationAction({
  kind,
  branchName,
  scope,
  mutationPending,
  onTriggered,
}: GitBranchConversationActionProps) {
  const { intl } = useZCodeIntl();
  const messageIds = ACTION_MESSAGE_IDS[kind];
  const available = useSyncExternalStore(
    subscribeWorkspaceConversationPromptRuntime,
    () => getWorkspaceConversationPromptAvailability(scope),
    () => "unavailable",
  );
  const handleAction = useCallback(() => {
    onTriggered();
    requestWorkspaceConversationPrompt(
      scope,
      intl.formatMessage({ id: messageIds.prompt }, { branchName }),
    );
  }, [branchName, intl, messageIds.prompt, onTriggered, scope]);

  if (available === "unavailable") {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={mutationPending}
      aria-label={intl.formatMessage({ id: messageIds.aria }, { branchName })}
      className="-mt-0.5 shrink-0 rounded-sm"
      onClick={(event) => {
        // 阻止冒泡到 cmdk Item，避免行内动作被当作分支切换。
        event.stopPropagation();
        handleAction();
      }}
    >
      {intl.formatMessage({ id: messageIds.action })}
    </Button>
  );
}
