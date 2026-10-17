import {
  extractAssistantDirectives,
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
  type AssistantTextRange,
} from "@/lib/assistantDirectiveParser.js";

/**
 * 助手正文里"裸绝对路径 → markdown 文件链接"的纯改写。
 *
 * Agent 经常把导出文件以裸路径写在正文里（历史提示词甚至鼓励这么做），这些路径
 * 原样不可点击。渲染前把它们改写成 `[文件名](路径)`，即可复用 MessageFileLink
 * 的全部行为（数据/办公类点击直接下载、右键打开/下载/复制）。
 *
 * v1 保守边界：路径必须带路径前缀（`/`、`X:\`、`~/`、`./`、`../`）且不含空格；
 * 代码块/行内代码、已有链接与图片、assistant 指令、URL 一律不动。
 */

/** 已有 markdown 链接或图片 `!?[...](...)` 的整体区间。 */
const EXISTING_LINK_RE = /!?\[[^\]\n]*\]\([^)\n]*\)/g;

/** file:// 与 http(s):// URL，避免 `https://x/a.csv` 被当成路径。 */
const URL_RE = /\b(?:file|https?):\/\/[^\s<>())]+/giu;

const KNOWN_DIRECTIVE_NAMES = ["code-comment", "zcode-file-citation"] as const;

/**
 * 路径形候选：
 * - 前缀必须是 `/`、`X:\`、`X:/`、`~/`、`./`、`../` 之一（裸文件名不链接，避免正文误伤）；
 * - 段内不允许空白与 markdown/URL 敏感字符（含空格与括号——括号在 CommonMark
 *   目标地址里需要配平，v1 直接不匹配含括号路径）；
 * - 以 `.` + 1~8 位字母数字扩展名结尾（行号后缀 `:12:34` 不在匹配内）；
 * - 前一个字符不能是字母数字/点/冒号/分隔符（挡住 `https:` 的残余段与长标识符中段）。
 */
const BARE_PATH_RE =
  /(?<![\w:./\\])((?:~\/|\.{1,2}\/|[a-zA-Z]:[\\/]|\/)[^\s<>\]["'`*|!()（）]+?\.[A-Za-z0-9]{1,8})(?=$|[\s)\]}'">,.;:!?，。！？；：、…（）])/gu;

function collectProtectedRanges(content: string): AssistantTextRange[] {
  const ranges: AssistantTextRange[] = [...findMarkdownCodeRanges(content)];
  for (const pattern of [EXISTING_LINK_RE, URL_RE]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push([start, start + match[0].length]);
    }
  }
  for (const name of KNOWN_DIRECTIVE_NAMES) {
    for (const directive of extractAssistantDirectives(content, name)) {
      ranges.push([directive.start, directive.end]);
    }
  }
  return ranges;
}

function pathBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

export function rewriteBareFilePathsToMarkdownLinks(content: string): string {
  // Windows 路径只有反斜杠，两种分隔符都要看。
  if (!content || (!content.includes("/") && !content.includes("\\"))) {
    return content;
  }
  const protectedRanges = collectProtectedRanges(content);

  const rewrites: Array<{ start: number; end: number; replacement: string }> = [];
  for (const match of content.matchAll(BARE_PATH_RE)) {
    const path = match[1] ?? "";
    const start = (match.index ?? 0) + match[0].indexOf(path);
    const end = start + path.length;
    if (!path || overlapsAssistantTextRanges(start, end, protectedRanges)) {
      continue;
    }
    rewrites.push({ start, end, replacement: `[${pathBasename(path)}](${path})` });
  }
  if (rewrites.length === 0) {
    return content;
  }

  // 从后往前替换，避免前面改写改变后面区间的偏移。
  let result = content;
  for (const rewrite of rewrites.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, rewrite.start) + rewrite.replacement + result.slice(rewrite.end);
  }
  return result;
}
