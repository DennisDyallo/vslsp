type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: LogLevel = "error";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  // Reserved fields placed last so callers cannot overwrite level/ts/msg
  const entry = { ...extra, level, ts: new Date().toISOString(), msg };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
