/**
 * 命令中心搜索范围的纯函数定义：scope 类型、前缀双向映射与查询解析。
 * 独立成模块便于单测，并被搜索历史与弹窗共同复用（见 specs/command-center.md）。
 */
export type CommandCenterSearchScope = "all" | "commands" | "conversations" | "files" | "contents";

export function isCommandCenterSearchScope(value: unknown): value is CommandCenterSearchScope {
  return (
    value === "all" ||
    value === "commands" ||
    value === "conversations" ||
    value === "files" ||
    value === "contents"
  );
}

/** 搜索历史 chip 的 scope 前缀（如 commands → ">"）。 */
export function scopeToPrefix(scope: CommandCenterSearchScope): string {
  switch (scope) {
    case "commands":
      return ">";
    case "conversations":
      return "#";
    case "files":
      return "@";
    case "contents":
      return "$";
    default:
      return "";
  }
}

export function resolveQueryScope(rawQuery: string): {
  query: string;
  scope: CommandCenterSearchScope;
  explicitScope: boolean;
} {
  const trimmed = rawQuery.trimStart();
  const prefix = trimmed[0];
  if (prefix === ">") {
    return { query: trimmed.slice(1).trimStart(), scope: "commands", explicitScope: true };
  }
  if (prefix === "#") {
    return { query: trimmed.slice(1).trimStart(), scope: "conversations", explicitScope: true };
  }
  if (prefix === "@") {
    return { query: trimmed.slice(1).trimStart(), scope: "files", explicitScope: true };
  }
  if (prefix === "$") {
    return { query: trimmed.slice(1).trimStart(), scope: "contents", explicitScope: true };
  }

  return { query: rawQuery.trim(), scope: "all", explicitScope: false };
}
