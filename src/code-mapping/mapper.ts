import { resolve } from "path";
import { existsSync } from "fs";
import { DEFAULT_CODE_MAPPER } from "../core/defaults";

export interface MapOptions {
  path: string;
  format: "text" | "json" | "yaml";
  output?: string;
  codeMapperPath?: string;
}

export interface MapResult {
  output: string;
  exitCode: number;
}

export async function map(options: MapOptions): Promise<MapResult> {
  const codeMapperPath = resolve(options.codeMapperPath || DEFAULT_CODE_MAPPER);

  if (!existsSync(codeMapperPath)) {
    throw new Error(
      `CodeMapper binary not found at: ${codeMapperPath}\n` +
      "Run 'vslsp build-tools' or install CodeMapper manually."
    );
  }

  const targetPath = resolve(options.path);
  if (!existsSync(targetPath)) {
    throw new Error(`Path not found: ${targetPath}`);
  }

  const args = [targetPath, "--format", options.format];
  if (options.output) {
    args.push("--output", resolve(options.output));
  }

  const proc = Bun.spawn([codeMapperPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  // Combine stdout and stderr for full output
  const output = (stdout + (stderr ? "\n" + stderr : "")).trim();

  return { output, exitCode };
}
