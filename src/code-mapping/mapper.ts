import { resolve } from "path";
import { existsSync } from "fs";
import { DEFAULT_CODE_MAPPER } from "../core/defaults";
import { detectLanguage, getMapper } from "./registry";

export interface MapOptions {
  path: string;
  format?: "text" | "json" | "yaml";
  output?: string;
  codeMapperPath?: string;
  language?: string;
}

export interface MapResult {
  output: string;
  exitCode: number;
}

export async function map(options: MapOptions): Promise<MapResult> {
  // Resolve binary: explicit language > extension detection > legacy codeMapperPath > C# default
  let binaryPath: string;
  if (options.language) {
    const m = getMapper(options.language);
    binaryPath = m?.binaryPath ?? options.codeMapperPath ?? DEFAULT_CODE_MAPPER;
  } else if (options.codeMapperPath) {
    binaryPath = options.codeMapperPath;
  } else {
    const detected = detectLanguage(options.path);
    binaryPath = detected?.binaryPath ?? DEFAULT_CODE_MAPPER;
  }

  binaryPath = resolve(binaryPath);

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Mapper binary not found at: ${binaryPath}\n` +
      "Run 'vslsp build-tools' or install the appropriate mapper."
    );
  }

  const targetPath = resolve(options.path);
  if (!existsSync(targetPath)) {
    throw new Error(`Path not found: ${targetPath}`);
  }

  const format = options.format ?? "json";
  const args = [targetPath, "--format", format];
  if (options.output) {
    args.push("--output", resolve(options.output));
  } else {
    args.push("--stdout");
  }

  const proc = Bun.spawn([binaryPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  // stdout is the structured output; stderr is progress/errors
  const output = (stdout + (stderr ? "\n" + stderr : "")).trim();

  return { output, exitCode };
}
