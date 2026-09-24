# Spec: 底部终端左右拆分

> 实现入口：`packages/ui/src/Terminal.tsx`（面板与按钮）、`packages/ui/src/terminal/terminalPanelState.ts`（状态纯函数）、`packages/ui/src/terminal/TerminalSession.tsx`（xterm 会话）。
> 本 spec 只覆盖底部终端面板的拆分视图；Side Pane 终端不参与拆分，其行为保持不变。

## 1. 产品规则

- 终端面板头部操作区在「新建终端」（`+`）左侧新增「拆分终端」按钮（`SplitSquareHorizontal` 图标，`terminal.split` 文案）。office 模式下与 `+` 一同隐藏（该模式本就不提供终端操作）。
- 点击拆分按钮：对「最后一个打开的终端窗口」做纵向均分（左右各占一半），右侧为新开窗口（新 PTY 会话，非视图复制）；新窗口获得焦点。支持连续多次拆分，每次都对当前最后打开的窗口再拆分，该组所有可见窗口重新等宽均分。
- **拆分后的窗口归为一组**：组关系持久保持。`+` 新建的终端进入自己的单窗口组并切换过去，不破坏既有组；切回拆分组成员的任一 tab 都整组恢复拆分布局（不会变回单窗口）。tab 点击永远只切换焦点、不改布局。
- 「最后一个打开的终端窗口」= 当前 workspace `sessionIds`（创建顺序）中最后一个仍存活的 session。缺省路径下它就是焦点终端；用户切走焦点后再拆分时仍按创建顺序的最后一个裁决。
- 可见窗口内点击/聚焦时同步 `activeSessionId`，tab 高亮跟随真实焦点终端。
- 组成员被关闭（手动关闭或 PTY 退出）后从所在组移除；组内剩余 1 个窗口即退化为普通单窗口组。关闭焦点终端时，焦点优先落到同组相邻窗口（左邻优先，其次右邻），同组无邻居时沿用 `sessionIds` 相邻规则。
- 不提供显式「取消拆分」入口（与常见终端一致）；关闭成员即可逐步收缩组。

## 2. 状态所有者与不变量

- 唯一所有者：`Terminal.tsx` 的 `setPanelState`，状态迁移全部收敛在 `terminalPanelState.ts` 纯函数中（`splitTerminalSession` / `closeTerminalSession` / `exitTerminalSession` / `ensureWorkspaceTerminalState`）。
- `TerminalWorkspaceState` 新增必填字段 `splitGroups: string[][]`（含单窗口组，组内左→右有序）：
  - 每个 session 恰好属于一个组；组内顺序与创建顺序一致（拆分目标恒为组尾的最后打开成员，新成员插到其右侧）；
  - **可见集合 = `activeSessionId` 所在组的成员**，长度 ≥2 的组即拆分布局，单成员组即普通全宽窗口；
  - 组随 workspace 状态隔离存储，切换 workspace 只切换可见集合，不卸载 PTY（沿用现有保活语义）。
- `TerminalSession` 拆分「可见」与「聚焦」两个语义：`isVisible` 控制 fit/resize/PTY 尺寸，新增可选 `isFocused` 控制 `term.focus()`；`isFocused` 缺省等于 `isVisible`，Side Pane 路径不传该 prop，行为字节级不变。
- 渲染层不再用 `TabsContent` 表达内容区可见性：内容区改为 flex 行，焦点组成员按左→右各占 `flex-1`（等宽均分）并加分隔边框，其余 session（含其他 workspace）`hidden` 但保持挂载。`Tabs` 根组件与 `TabsTrigger` 继续承担 tab 栏。

## 3. 事件顺序（点击拆分按钮）

```text
click 拆分按钮
  └─ setPanelState（同一所有者、单次同步迁移）
       1. ensureWorkspaceTerminalState        兜底懒创建（面板被 PTY 退出清空后重开）
       2. target = sessionIds 最后一项         「最后打开」裁决
       3. createTerminalSession               新 uuid + 最小空位编号（既有规则）
       4. splitGroups                         新 session 插到 target 所在组、target 右侧；
                                              target 不在任何组（理论不可达）时以 [target, new] 新建一组
       5. activeSessionId = 新 session        右侧新窗口获得焦点
  └─ React 提交
       ├─ 焦点组成员等宽 flex-1 重排
       ├─ 组内既有 pane：容器宽度减半 → ResizeObserver → fit → terminalService.resize（既有节流/队列路径）
       └─ 新 TerminalSession：首帧 fit 后以真实 cols/rows 创建 PTY（既有 create 路径）
```

`+` 新建：同一所有者内追加新组 `[new]` 并把焦点切过去，`splitGroups` 其余组原样保留。
无远端、无跨进程时序变更；PTY resize 仍走 TerminalSession 内部 pending/in-flight 队列，不新增写路径。

## 4. 失败语义

- 拆分目标不存在（workspace 刚被清空）：`ensureWorkspaceTerminalState` 先懒创建首个 session，拆分正常进行。
- `splitGroups` 中出现已不存在的 session id（理论不可达）：关闭路径统一按存活成员过滤移除。
- 焦点终端不在任何组（理论不可达）：渲染层回退为以焦点终端自组（单窗口），不崩溃。
- 焦点组成员 PTY 退出：走既有 `exitTerminalSession` → `closeTerminalSession` 路径，组收缩与焦点落点见 §1；最后一个 session 退出仍按既有语义关闭面板并清空 workspace 记录（组随之消失）。
- pane 宽度过窄：沿用 xterm fit 的最小列数行为，不设拆分次数上限（关闭成员随时可收缩组）。

## 5. 验收场景

1. 单终端点击拆分：左右等分两窗，右侧为新 shell 并获得焦点，tab 栏多出对应 tab。
2. 连续点击拆分：继续对最右窗口拆分，组内窗口等宽重排（3 窗、4 窗……），各窗口内容独立、PTY 互不影响。
3. 拆分后点 `+`：新终端以全宽单窗口出现并聚焦；再点回拆分组的任一 tab：**整组恢复拆分布局**，焦点落在被点击的成员上。
4. 拆分组与单窗口组并存：点拆分组 tab 恢复整组，点单窗口 tab 只显示该窗口，两组关系互不影响。
5. 拆分态点击组内 tab：仅焦点与 tab 高亮切换，布局不变。
6. 关闭组内中间窗口：该 pane 消失、其余重新均分；组内剩 1 个时退化为普通单窗口。
7. 关闭焦点终端：焦点落到同组左邻（无左邻取右邻）。
8. 拆分后左侧终端宽度减半，PTY 列数随 resize 更新（行不串位）。
9. 切换 workspace tab 再切回：分组布局保持，长时间运行的命令不中断。
10. office 模式：拆分按钮与 `+` 一同隐藏。
