import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

interface NotifyOptions {
  port: number;
  file: string;
  content?: string;
}

export async function notify(options: NotifyOptions): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`;
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
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
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

    const data = await response.json() as { ok: boolean; action: string; path: string };
    console.log(`Notified: ${data.action} for ${data.path}`);
  } catch (err) {
    if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("ConnectionRefused") || (err as any).code === "ConnectionRefused")) {
      console.error(`Error: Cannot connect to vslsp daemon at localhost:${options.port}`);
      console.error("Is the daemon running? Start it with: vslsp serve --solution <path.sln>");
      process.exit(1);
    }
    throw err;
  }
}
