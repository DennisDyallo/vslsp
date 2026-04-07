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
  for (const mapper of LANGUAGE_REGISTRY) {
    if (mapper.extensions.some(ext => targetPath.endsWith(ext))) return mapper;
  }
  return null;
}

export function getMapper(language: string): LanguageMapper | undefined {
  return LANGUAGE_REGISTRY.find(m => m.language === language);
}
