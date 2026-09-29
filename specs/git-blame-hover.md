# Spec: 审查文件视图 git blame 悬停提示

## 行为

- 右侧文件视图的所有代码类入口，鼠标悬停某行超过 0.3 秒，弹出该行的最后提交人与提交日期；
  未提交行显示「未提交」。已覆盖入口：
  1. PreviewPane patch 源（对话文件摘要卡「审查」）——轻量降级视图与富 DiffViewer 双路径
  2. PreviewPane multi-file-diff 源（before/after 单文件对比）
  3. PreviewPane 纯文件视图（`text` 源 → CodeViewer；左侧项目目录点进来的文件走这里）
  4. 审查侧栏 GitPane 展开的变更卡片（patch 与 multi-file 两种 DiffViewer 输入）
- 数据按文件整取（`git blame --line-porcelain`）+ 全局按「workspace+路径」缓存（FIFO 上限 50），
  避免逐行 spawn git。
- 暂不覆盖：GitPaneChangeCard 的大文件轻量 hunk 预览（行号映射需要独立推导，二期）。

## 所有者与边界

- 数据所有者：Host 端 `IGitService.getBlame`（`gitCliRepo` 执行 + `parseBlamePorcelain` 解析）。
- 未跟踪新文件（尚未 commit）：blame 失败但 `git ls-files` 为空 → 返回空行集，UI 全行按「未提交」；
  非 git 目录/命令失败 → 返回 null，UI 不提示。
- 富 DiffViewer 在 Shadow DOM 内渲染，行元素带 `data-line`；悬停事件经 `composedPath` 穿透识别。
- 轻量降级视图行号由 `getPatchPreviewNewFileLineNumbers` 从 hunk 头推导（与降级行过滤语义严格一致，
  长度不一致时禁用 blame，防止错位）。

## 验收

1. HEAD 内已提交文件：悬停 0.3s 显示「作者 · 日期」。
2. 未提交修改行/未跟踪新文件：显示「未提交」。
3. 非 git 目录：无提示，无报错。
