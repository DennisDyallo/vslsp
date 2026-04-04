import { DEFAULT_CODE_MAPPER, DEFAULT_RUST_MAPPER, DEFAULT_TS_MAPPER } from "../core/defaults";

export interface LanguageMapper {
  language: string;
  extensions: string[];
  binaryPath: string;
}

export const LANGUAGE_REGISTRY: LanguageMapper[] = [
  { language: "csharp", extensions: [".cs"], binaryPath: DEFAULT_CODE_MAPPER },
  { language: "rust",   extensions: [".rs"], binaryPath: DEFAULT_RUST_MAPPER },
  { language: "typescript", extensions: [".ts", ".tsx"], binaryPath: DEFAULT_TS_MAPPER },
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
