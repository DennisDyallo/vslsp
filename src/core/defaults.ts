import { join } from "path";

export const DEFAULT_PORT = 7850;

export const DEFAULT_OMNISHARP = join(
  process.env.HOME || "~",
  ".local",
  "share",
  "vslsp",
  "omnisharp",
  "OmniSharp"
);

export const DEFAULT_CODE_MAPPER = join(
  process.env.HOME || "~",
  ".local",
  "share",
  "vslsp",
  "code-mapper",
  "CodeMapper"
);

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
