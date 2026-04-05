import { existsSync } from "fs";
import { resolve } from "path";

export interface QueryOptions {
  port: number;
  file?: string;
  summary: boolean;
}

export interface QueryResult {
  data: any;
  clean: boolean;
}

export interface NotifyOptions {
  port: number;
  file: string;
  content?: string;
}

export interface NotifyResult {
  ok: boolean;
  action: string;
  path: string;
}

export interface StatusResult {
  solution: string;
  ready: boolean;
  updateCount: number;
  lastUpdate: string;
}

function connectionError(port: number): never {
  const err = new Error(
    `Cannot connect to vslsp daemon at 127.0.0.1:${port}. ` +
    "Is the daemon running? Start it with: vslsp serve --solution <path.sln>"
  );
  (err as any).code = "DAEMON_NOT_RUNNING";
  throw err;
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("ECONNREFUSED") ||
    err.message.includes("ConnectionRefused") ||
    (err as any).code === "ConnectionRefused";
}

export async function query(options: QueryOptions): Promise<QueryResult> {
  const baseUrl = `http://127.0.0.1:${options.port}`;

  try {
    let endpoint = "/diagnostics";
    if (options.summary) {
      endpoint = "/diagnostics/summary";
    } else if (options.file) {
      endpoint = `/diagnostics?file=${encodeURIComponent(options.file)}`;
    }

    const response = await fetch(`${baseUrl}${endpoint}`);

    if (!response.ok) {
      const error = await response.json() as { error: string };
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const data = await response.json() as { clean?: boolean };
    const clean = options.summary || !("clean" in data) || data.clean === true;

    return { data, clean };
  } catch (err) {
    if (isConnectionError(err)) connectionError(options.port);
    throw err;
  }
}

export async function status(port: number): Promise<StatusResult> {
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${baseUrl}/status`);

    if (!response.ok) {
      const error = await response.json() as { error: string };
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return await response.json() as StatusResult;
  } catch (err) {
    if (isConnectionError(err)) connectionError(port);
    throw err;
  }
}

export async function stop(port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${baseUrl}/stop`, { method: "POST" });
  } catch (err) {
    if (isConnectionError(err)) connectionError(port);
    // Ignore other errors — process may exit before response arrives
  }
}

export async function notify(options: NotifyOptions): Promise<NotifyResult> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const filePath = resolve(options.file);

  try {
    let endpoint: string;
    let body: object;

    if (options.content !== undefined) {
      // Send content change (didChange)
      endpoint = "/file-content";
      body = { path: filePath, content: options.content };
    } else {
      // File saved on disk (didSave)
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      endpoint = "/file-changed";
      body = { path: filePath };
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json() as { error: string };
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return await response.json() as NotifyResult;
  } catch (err) {
    if (isConnectionError(err)) connectionError(options.port);
    throw err;
  }
}
