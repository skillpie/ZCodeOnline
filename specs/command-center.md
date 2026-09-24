# Spec: 命令中心搜索（Command Center）

> 顶部搜索弹窗（`packages/ui/src/command-center/CommandCenterDialog.tsx`）：聚合操作、任务、文件与文件内容的全局搜索。

## 1. 产品规则

- 搜索弹窗提供五个范围 tab：`全部` / `操作` / `任务` / `文件` / `内容`，顺序固定；`内容` 排在 `文件` 之后。
- 输入前缀可显式切范围：`>` 操作、`#` 任务、`@` 文件、`$` 内容；无前缀时跟随手动选择的 tab（默认全部）。
- `内容` 范围全局搜索 workspace 内的**文件内容**（非文件名）：
  - 搜索在 Host 侧执行，尊重 `.zcodeignore`（与文件名搜索同一份规则与索引源），不额外引入第二套忽略配置。
  - 大小写不敏感的子串匹配；查询按空白分词，行内需包含全部词（AND）。
  - 点击结果打开右侧代码预览并定位到匹配行（`initialLine`）；重复点击同一结果也重新滚动定位。
- 搜索历史记录范围前缀，`$` 前缀的历史 chip 点击后恢复内容搜索范围。
- 不做：正则搜索、全局替换、跨 workspace 内容搜索、搜索结果索引持久化。

## 2. 状态所有者

```text
Renderer（CommandCenterDialog 组件局部 state）
  │  持有：查询词、manualScope、内容搜索结果/loading/error（250ms debounce + requestId 丢弃过期结果）
  │  仅通过 IFileService RPC 读写，不缓存第二事实
  ▼
Host 端 IFileService.searchWorkspaceContent（无状态）
  └─ 复用 listWorkspaceFiles 的 60s TTL 文件索引（.zcodeignore 指纹失效），每次调用独立有界扫描
```

- 内容搜索结果不落库、不广播；tab 关闭即丢弃。
- 取消语义：renderer 以 debounce + `cancelled` 标志丢弃过期响应；Host 不提供取消通道，靠「有界扫描」（见 §3）保证单次查询成本上限。

## 3. 接口（channel：`file`）

```ts
interface WorkspaceContentSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number; // 全局匹配上限，缺省 100，clamp [1, 100]
}

interface WorkspaceContentSearchMatch {
  path: string; // 绝对路径
  relativePath: string; // workspace 相对路径（POSIX 分隔）
  name: string; // 文件名
  line: number; // 1-based 行号
  text: string; // 匹配行 trim 后内容（≤240 字符）
}

interface IFileService {
  searchWorkspaceContent(
    params: WorkspaceContentSearchParams,
  ): Promise<WorkspaceContentSearchMatch[]>;
}
```

Host 扫描边界（常量收口在 `fileService.ts`）：

| 边界           | 值     | 目的                                                          |
| -------------- | ------ | ------------------------------------------------------------- |
| 全局匹配上限   | 100    | 达到即早停                                                    |
| 单文件匹配上限 | 5      | 避免单文件刷屏                                                |
| 单文件读取上限 | 256 KB | 与 readTextFile 的 MAX_TEXT_READ_BYTES 一致，超限文件整只跳过 |
| 扫描总字节预算 | 32 MB  | 无命中查询的成本上限                                          |
| 扫描文件数上限 | 20 000 | 超大仓库保证有界终止                                          |
| 扫描并发       | 4      | 共享目录队列风格，块间让出事件循环                            |

- 文件清单来自既有 `ensureWorkspaceFileIndex`（60s TTL + `.zcodeignore` 指纹），仅扫描 `type === "file"` 的候选；命中上限后立刻停止派发新文件。
- 疑似二进制文件（复用 `isProbablyBinary` 首块探测）整只跳过。
- 结果按索引顺序（relativePath 升序）返回，确定性排序，不按相关度打分。

## 4. 事件顺序与失败语义

```text
Renderer                                    Host(FileService)
  │ 输入停顿 250ms（debounce）                │
  │ ├─ 发起 searchWorkspaceContent(query) ──▶│ ensureWorkspaceFileIndex（TTL 缓存）
  │ │  上一请求 cancelled=true，响应即丢弃     │ 受限并发扫描（有界，命中早停）
  │ ◀──────── WorkspaceContentSearchMatch[] ──┤
  │ └─ 渲染结果区；点击 → onOpenCodeViewer     │
  │    { type:"file", initialLine, focusKey } │
```

- 查询为空或范围不含内容时不发请求，残留结果清空。
- Host 错误以文本显示在内容结果区（destructive 色），不打断输入、不 toast。
- 打开定位：`FileCodeViewerSource` 新增可选 `initialLine`（目标行）与 `initialLineFocusKey`（每次点击唯一，驱动 CodeViewer 重跑滚动 effect）；带 `initialLine` 的 file source 跳过 markdown/SVG 预览分支，保证一定落在代码视图完成行定位。
- 行号超出文件实际行数时，CodeViewer 定位 effect 静默失败（现有 retry 上限后放弃），预览正常展示文件开头。

## 5. 验收场景

1. 打开搜索弹窗，tab 栏出现「内容」，位于「文件」之后；点选后输入关键词，结果区展示 文件名 + 目录 + 行片段 + 行号。
2. 点击内容结果 → 右侧打开该文件代码预览，视口滚动到匹配行且该行高亮。
3. 再次点击同一结果 → 预览已在该 tab 时仍重新滚动定位。
4. `$关键词` 前缀直接进入内容搜索；搜索历史 chip 带 `$` 前缀，点击恢复内容范围。
5. `.zcodeignore` 排除的文件（如 `node_modules/`）不出现在内容结果中。
6. 无命中时显示「暂无相关结果」；Host 异常时结果区显示错误文本，输入可继续。
