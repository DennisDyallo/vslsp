import { execSync } from "child_process";
import { basename, dirname, join } from "path";
import { DEFAULT_OMNISHARP, DEFAULT_PORT, DEFAULT_TS_PORT, DEFAULT_RUST_PORT } from "./defaults";

export type DaemonLanguage = "csharp" | "typescript" | "rust";

export interface LanguageConfig {
  language: DaemonLanguage;
  languageId: string;
  resolveServerBinary: () => string;
  serverArgs: (manifestPath: string) => string[];
  rootUri: (manifestPath: string) => string;
  watchExtensions: string[];
  manifestValidator: (path: string) => void;
  defaultPort: number;
  minWaitMs: number;
  quietPeriodMs: number;
  initializationOptions?: (manifestPath: string) => object;
}

const CSHARP_CONFIG: LanguageConfig = {
  language: "csharp",
  languageId: "csharp",
  resolveServerBinary: () => DEFAULT_OMNISHARP,
  serverArgs: (manifestPath) => ["-lsp", "-s", manifestPath],
  rootUri: (manifestPath) => `file://${dirname(manifestPath)}`,
  watchExtensions: [".cs"],
  manifestValidator: (path) => {
    if (!path.endsWith(".sln")) {
      throw new Error(`C# daemon requires a .sln file, got: ${path}`);
    }
  },
  defaultPort: DEFAULT_PORT,
  minWaitMs: 10000,
  quietPeriodMs: 3000,
};

const TYPESCRIPT_CONFIG: LanguageConfig = {
  language: "typescript",
  languageId: "typescript",
  resolveServerBinary: () => {
    try {
      return execSync("which typescript-language-server", { encoding: "utf-8" }).trim();
    } catch {
      // Fall back to local node_modules
      const localBin = join(__dirname, "..", "..", "node_modules", ".bin", "typescript-language-server");
      return localBin;
    }
  },
  serverArgs: () => ["--stdio"],
  rootUri: (manifestPath) => `file://${dirname(manifestPath)}`,
  watchExtensions: [".ts", ".tsx", ".js", ".jsx"],
  manifestValidator: (path) => {
    if (basename(path) !== "tsconfig.json") {
      throw new Error(`TypeScript daemon requires a tsconfig.json file, got: ${path}`);
    }
  },
  defaultPort: DEFAULT_TS_PORT,
  minWaitMs: 5000,
  quietPeriodMs: 2000,
  initializationOptions: () => ({ tsserver: {} }),
};

const RUST_CONFIG: LanguageConfig = {
  language: "rust",
  languageId: "rust",
  resolveServerBinary: () => {
    try {
      return execSync("rustup which rust-analyzer", { encoding: "utf-8" }).trim();
    } catch {
      throw new Error(
        "rust-analyzer not found. Run `rustup component add rust-analyzer` to install it."
      );
    }
  },
  serverArgs: () => [],
  rootUri: (manifestPath) => `file://${dirname(manifestPath)}`,
  watchExtensions: [".rs"],
  manifestValidator: (path) => {
    if (basename(path) !== "Cargo.toml") {
      throw new Error(`Rust daemon requires a Cargo.toml file, got: ${path}`);
    }
  },
  defaultPort: DEFAULT_RUST_PORT,
  minWaitMs: 8000,
  quietPeriodMs: 3000,
};

const LANGUAGE_CONFIGS: Record<DaemonLanguage, LanguageConfig> = {
  csharp: CSHARP_CONFIG,
  typescript: TYPESCRIPT_CONFIG,
  rust: RUST_CONFIG,
};

/** Detect language from manifest file path. */
export function detectLanguage(manifestPath: string): DaemonLanguage {
  const name = basename(manifestPath);
  if (name.endsWith(".sln")) return "csharp";
  if (name === "tsconfig.json") return "typescript";
  if (name === "Cargo.toml") return "rust";
  throw new Error(
    `Cannot detect language from manifest path: ${manifestPath}. ` +
    `Expected a .sln, tsconfig.json, or Cargo.toml file.`
  );
}

/** Get the full language configuration for a given language. */
export function getLanguageConfig(lang: DaemonLanguage): LanguageConfig {
  return LANGUAGE_CONFIGS[lang];
}

/**
 * Resolve the LSP languageId for a specific file.
 * TypeScript/JavaScript files need per-extension disambiguation.
 */
export function resolveLanguageId(lang: DaemonLanguage, filePath: string): string {
  if (lang === "typescript") {
    if (filePath.endsWith(".tsx")) return "typescriptreact";
    if (filePath.endsWith(".jsx")) return "javascriptreact";
    if (filePath.endsWith(".js")) return "javascript";
    return "typescript";
  }
  return LANGUAGE_CONFIGS[lang].languageId;
}
