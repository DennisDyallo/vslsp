interface QueryOptions {
  port: number;
  file?: string;
  summary: boolean;
  format: "compact" | "pretty";
}

export async function query(options: QueryOptions): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`;

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
    const output = options.format === "pretty"
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
    
    console.log(output);

    // Exit with error code if there are errors (only for full diagnostics)
    if (!options.summary && "clean" in data && !data.clean) {
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("ConnectionRefused") || (err as any).code === "ConnectionRefused")) {
      console.error(`Error: Cannot connect to vslsp daemon at localhost:${options.port}`);
      console.error("Is the daemon running? Start it with: vslsp serve --solution <path.sln>");
      process.exit(1);
    }
    throw err;
  }
}

export async function status(port: number): Promise<void> {
  const baseUrl = `http://localhost:${port}`;

  try {
    const response = await fetch(`${baseUrl}/status`);
    
    if (!response.ok) {
      const error = await response.json() as { error: string };
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("ConnectionRefused") || (err as any).code === "ConnectionRefused")) {
      console.error(`Error: Cannot connect to vslsp daemon at localhost:${port}`);
      console.error("Is the daemon running? Start it with: vslsp serve --solution <path.sln>");
      process.exit(1);
    }
    throw err;
  }
}
