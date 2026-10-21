// 项目树是唯一组织视图；workspace tab 继续只负责导航与执行目录。
// v3.16.2 起 sidebar 切换为官方 ProjectSidebar（packages/ui/src/project-sidebar/），
// fork 能力（技能市场入口等）直接实现在 ProjectSidebar 内，不再维护旧单体实现。
export { ProjectSidebar as WorkspaceSidebar } from "@/project-sidebar/index.js";
export type { SidebarFileTreeOpenRequest } from "@/project-sidebar/contract.js";
