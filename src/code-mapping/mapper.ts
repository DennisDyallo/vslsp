import { resolve } from "path";
import { existsSync } from "fs";
import { DEFAULT_CSHARP_MAPPER } from "../core/defaults";
import { detectLanguage, getMapper } from "./registry";
import { log } from "../core/logger";

export interface MapOptions {
  path: string;
  format?: "text" | "json" | "yaml";
  output?: string;
  codeMapperPath?: string;
  language?: string;
  visibility?: "all" | "public";
}

export interface MapResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

export async function map(options: MapOptions): Promise<MapResult> {
  // Detect language once — reused for binary resolution, error messages, and visibility flag
  const detected = options.language ? getMapper(options.language) : detectLanguage(options.path);
  const lang = detected?.language ?? options.language;

  // Resolve binary: explicit language > legacy codeMapperPath > extension detection > C# default
  let binaryPath: string;
  if (options.language && detected) {
    binaryPath = detected.binaryPath;
  } else if (options.codeMapperPath) {
    binaryPath = options.codeMapperPath;
  } else if (detected) {
    binaryPath = detected.binaryPath;
  } else {
    binaryPath = DEFAULT_CSHARP_MAPPER;
  }

  binaryPath = resolve(binaryPath);

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Mapper binary not found at: ${binaryPath}\n` +
      `Install it with: vslsp install-mapper ${lang ?? "csharp"}`
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
  // --visibility is only supported by CSharpMapper; Rust/TS mappers would
  // misinterpret the value as a positional path argument. Only pass for C#,
  // and only when non-default ("public" is the mapper's built-in default).
  if (options.visibility === "all" && lang === "csharp") {
    args.push("--visibility", "all");
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

  // stdout is structured output; stderr is progress/errors — keep separate
  if (stderr.trim()) {
    log("warn", "mapper stderr", { binary: binaryPath, stderr: stderr.trim() });
  }

  return { output: stdout.trim(), exitCode, stderr: stderr.trim() || undefined };
}
