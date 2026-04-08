import { statSync, readdirSync } from "fs";
import { DEFAULT_CSHARP_MAPPER, DEFAULT_RUST_MAPPER, DEFAULT_TS_MAPPER } from "../core/defaults";

export interface LanguageMapper {
  language: string;
  extensions: string[];
  binaryPath: string;
  binaryName: string;   // Release asset prefix: "CSharpMapper" | "RustMapper" | "TSMapper"
  installDir: string;   // Subdirectory under ~/.local/share/vslsp/
}

export const LANGUAGE_REGISTRY: LanguageMapper[] = [
  { language: "csharp",     extensions: [".cs"],         binaryPath: DEFAULT_CSHARP_MAPPER,
    binaryName: "CSharpMapper", installDir: "csharp-mapper" },
  { language: "rust",       extensions: [".rs"],         binaryPath: DEFAULT_RUST_MAPPER,
    binaryName: "RustMapper",   installDir: "rust-mapper" },
  { language: "typescript", extensions: [".ts", ".tsx"], binaryPath: DEFAULT_TS_MAPPER,
    binaryName: "TSMapper",     installDir: "ts-mapper" },
];

export function detectLanguage(targetPath: string): LanguageMapper | null {
  // Fast path: single file — check extension directly
  for (const mapper of LANGUAGE_REGISTRY) {
    if (mapper.extensions.some(ext => targetPath.endsWith(ext))) return mapper;
  }

  // Directory path: check project manifests then top-level source files
  try {
    if (statSync(targetPath).isDirectory()) {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      const fileNames = entries.filter(e => e.isFile()).map(e => e.name);

      // Project manifest detection — reliable anchor even when source files are in subdirs
      if (fileNames.includes("tsconfig.json")) return getMapper("typescript") ?? null;
      if (fileNames.includes("Cargo.toml"))    return getMapper("rust") ?? null;
      if (fileNames.some(n => n.endsWith(".csproj") || n.endsWith(".sln"))) {
        return getMapper("csharp") ?? null;
      }

      // Fallback: source file extension scan at top level
      for (const mapper of LANGUAGE_REGISTRY) {
        if (fileNames.some(n => mapper.extensions.some(ext => n.endsWith(ext)))) return mapper;
      }
    }
  } catch {
    // Path doesn't exist or can't be read — fall through to null
  }

  return null;
}

export function getMapper(language: string): LanguageMapper | undefined {
  return LANGUAGE_REGISTRY.find(m => m.language === language);
}
