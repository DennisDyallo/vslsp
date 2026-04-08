import { join } from "path";
import { existsSync } from "fs";

export const DEFAULT_PORT = 7850;

export const DEFAULT_OMNISHARP = join(
  process.env.HOME || "~",
  ".local",
  "share",
  "vslsp",
  "omnisharp",
  "OmniSharp"
);

// Current install path. Falls back to legacy code-mapper/CodeMapper for pre-1.2 installs.
const _CSHARP_CURRENT = join(process.env.HOME || "~", ".local", "share", "vslsp", "csharp-mapper", "CSharpMapper");
const _CSHARP_LEGACY  = join(process.env.HOME || "~", ".local", "share", "vslsp", "code-mapper", "CodeMapper");
export const DEFAULT_CSHARP_MAPPER =
  existsSync(_CSHARP_CURRENT) ? _CSHARP_CURRENT :
  existsSync(_CSHARP_LEGACY)  ? _CSHARP_LEGACY  :
  _CSHARP_CURRENT; // neither found — produce correct install path in error message

export const DEFAULT_VSLSP = join(
  process.env.HOME || "~",
  ".local",
  "share",
  "vslsp",
  "vslsp"
);

export const DEFAULT_RUST_MAPPER = join(
  process.env.HOME || "~",
  ".local",
  "share",
  "vslsp",
  "rust-mapper",
  "RustMapper"
);

export const DEFAULT_TS_MAPPER = join(
  process.env.HOME || "~",
  ".local",
  "share",
  "vslsp",
  "ts-mapper",
  "TSMapper"
);
