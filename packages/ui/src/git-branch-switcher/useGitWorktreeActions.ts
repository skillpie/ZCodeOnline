import { useCallback, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { resolveGitWorktreeIssueMessageId } from "@/git-branch-switcher/display.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { getPathLeaf } from "@/lib/path.js";
import { buildWorktreeBranchName } from "@/lib/worktreeBranchName.js";
import { logger } from "@/logger.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { GitWorktreeMutationIssue } from "@zcode/shared";

interface UseGitWorktreeActionsOptions {
  workspacePath: string;
}

/**
 * 分支切换器 footer 的「新建 Worktree」：在主树 `.worktrees/` 下以分支
 * `feat/{6位随机数}` 检出为独立 worktree，目录名由服务端按「目录名 = 净化分支名」
 * 派生为 `feat-{同6位随机数}`，并作为独立项目打开。
 * worktree 在模型上是独立项目，不属于分支维度；分支切换器只保留这一个创建入口。
 * 「新建 Worktree」之外的创建入口是分支行的行尾动作：把一个未被任何工作树
 * 检出的既有分支检出为新 worktree（见 createWorktreeForBranch）。
 */
export function useGitWorktreeActions({ workspacePath }: UseGitWorktreeActionsOptions) {
  const { gitService } = useServices();
  // 项目登记必须写入侧栏读取的同一窗口目录服务；useServices 可能是远端 attachment 的服务组。
  const baseServices = useBaseWorkspaceServices();
  const projectService = (baseServices.windowProjectDirectory ?? baseServices).projectService;
  const { intl } = useZCodeIntl();
  const tabStoreApi = useTabStoreApi();
  const [worktreePending, setWorktreePending] = useState(false);

  const notifyWorktreeFailure = useCallback(
    (issues: GitWorktreeMutationIssue[], fallbackName: string) => {
      const issue = issues[0];
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      const messageId = resolveGitWorktreeIssueMessageId(issue);
      if (!messageId) {
        const fallbackMessage = issue.detail?.trim() || issue.message.trim();
        toast(
          fallbackMessage.length > 0
            ? fallbackMessage
            : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
        );
        return;
      }

      toast(intl.formatMessage({ id: messageId }, { detail: issue.detail ?? "" }));
    },
    [intl],
  );

  const openWorktreeTab = useCallback(
    (worktreePath: string, projectId?: string) => {
      // 与 useRootWorkspaceActions 打开本地目录一致：addTab 命中已打开 tab 时激活它；
      // startDraft 表达 workspace-only 意图，回到空草稿并清掉该 workspace 的 activeTaskId。
      // projectId 用于首发 createSession 的项目归属（reserveCreatedTask 写 project_id），
      // 缺失时首条会话会落入未归类「任务」而不在侧栏项目下。
      tabStoreApi.getState().addTab(worktreePath);
      useZCodeSessionStore
        .getState()
        .startDraft(worktreePath, undefined, undefined, projectId ? { projectId } : undefined);
    },
    [tabStoreApi],
  );

  /**
   * Bugfix：v3.16.2 侧栏切换为官方 ProjectSidebar 后，项目列表来自项目服务
   * readTree（虚拟项目注册表）；fork 的 worktree 流程只开 tab + UI 草稿、不走
   * prepareSession 目录准入，新目录不会进注册表，侧栏就看不到该 worktree
   * （旧单体侧栏直接列 workspace tab，无此问题）。这里在打开 tab 前按「新项目」
   * 同款 saveProject 把 worktree 目录登记为独立项目；登记失败不阻塞 worktree
   * 打开（目录已创建，可稍后手动添加项目）。
   */
  const registerWorktreeProject = useCallback(
    async (worktreePath: string): Promise<string | undefined> => {
      if (!projectService) return undefined;
      try {
        const tree = await projectService.readTree({ includeDeleted: false });
        const existing = tree.projects.find((project) =>
          project.roots.some((root) => root.rootPath === worktreePath),
        );
        if (existing) return existing.id;
        const saved = await projectService.saveProject({
          name: getPathLeaf(worktreePath),
          roots: [worktreePath],
          primaryRoot: worktreePath,
        });
        return saved.id;
      } catch (error: unknown) {
        logger.warn("[GitWorktreeActions] worktree 项目登记失败", {
          worktreePath,
          error: getErrorMessage(error),
        });
        return undefined;
      }
    },
    [projectService],
  );

  /** 两种创建模式的共同后置处理：失败 toast、成功 toast 并作为独立项目打开新 worktree。 */
  const settleAddWorktreeResult = useCallback(
    async (
      result: Awaited<ReturnType<typeof gitService.addWorktree>>,
      branchName: string,
    ): Promise<boolean> => {
      if (!result.ok || !result.worktree) {
        logger.warn("[GitWorktreeActions] 创建 worktree 被阻塞", {
          workspacePath,
          branchName,
          issues: result.issues.map((issue) => issue.code),
        });
        notifyWorktreeFailure(result.issues, branchName);
        return false;
      }

      logger.info("[GitWorktreeActions] 创建 worktree 成功", {
        workspacePath,
        branchName,
        worktreePath: result.worktree.path,
      });
      toast(
        intl.formatMessage({ id: "git.worktree.toast.created" }, { path: result.worktree.path }),
      );
      // 先登记项目再开 tab：addTab 触发侧栏项目树 refresh，readTree 才能读到新项目；
      // 同时把登记到的项目 id 带进草稿，首发会话归属该项目。
      const projectId = await registerWorktreeProject(result.worktree.path);
      openWorktreeTab(result.worktree.path, projectId);
      return true;
    },
    [intl, notifyWorktreeFailure, openWorktreeTab, registerWorktreeProject, workspacePath],
  );

  const createWorktreeForProject = useCallback(async () => {
    setWorktreePending(true);

    try {
      // 分支名撞已有分支时重摇；目录名不显式传，由服务端按「目录名 = 净化分支名」
      // 从 feat/{后缀} 派生为 feat-{同后缀}，与「以既有分支建 worktree」共用同一命名规则。
      const branches = await gitService.getLocalBranches({ workspacePath });
      const existingBranchNames = new Set(branches.branches.map((branch) => branch.name));
      const branchName = buildWorktreeBranchName(existingBranchNames);
      const result = await gitService.addWorktree({
        workspacePath,
        newBranchName: branchName,
      });
      await settleAddWorktreeResult(result, branchName);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitWorktreeActions] 创建 worktree 请求失败", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setWorktreePending(false);
    }
  }, [gitService, intl, settleAddWorktreeResult, workspacePath]);

  /** 分支行尾动作：把未被任何工作树检出的既有分支检出为独立 worktree。 */
  const createWorktreeForBranch = useCallback(
    async (branchName: string) => {
      setWorktreePending(true);

      try {
        // 检出既有分支模式不传 directoryName，由服务端按「目录名 = 净化分支名」约定派生，
        // 与 worktree 重命名的命名规则保持一致。
        const result = await gitService.addWorktree({ workspacePath, branchName });
        await settleAddWorktreeResult(result, branchName);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitWorktreeActions] 创建 worktree 请求失败", {
          workspacePath,
          branchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        setWorktreePending(false);
      }
    },
    [gitService, intl, settleAddWorktreeResult, workspacePath],
  );

  return {
    worktreePending,
    createWorktreeForProject,
    createWorktreeForBranch,
  };
}
