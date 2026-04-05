type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: LogLevel = "error";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  // Spread extra after reserved fields so callers cannot overwrite level/ts/msg
  const entry = { level, ts: new Date().toISOString(), msg, ...extra };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
