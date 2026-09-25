// relay 最小结构化日志（独立部署单元，不引 @zcode/services）。
// 鉴权/配对事件按 AGENTS.md 日志纪律落 info（生产可观测），只含元数据不含密钥明文。
export interface RelayLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export function createRelayLogger(scope: string): RelayLogger {
  const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
    process.stderr.write(`${JSON.stringify({ level, scope, message, ...fields })}\n`);
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
  };
}
