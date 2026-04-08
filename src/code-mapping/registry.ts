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

  // Directory path: scan top-level contents for files with matching extensions
  try {
    if (statSync(targetPath).isDirectory()) {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      for (const mapper of LANGUAGE_REGISTRY) {
        const hasMatch = entries.some(
          entry => entry.isFile() && mapper.extensions.some(ext => entry.name.endsWith(ext))
        );
        if (hasMatch) return mapper;
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
