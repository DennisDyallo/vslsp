#!/usr/bin/env bun
/**
 * Downloads the OmniSharp binary for the current platform.
 * Run with: bun run scripts/download-omnisharp.ts
 */
import { existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const OMNISHARP_VERSION = "v1.39.11";
const OMNISHARP_BASE_URL = `https://github.com/OmniSharp/omnisharp-roslyn/releases/download/${OMNISHARP_VERSION}`;

// Install globally to ~/.local/share/vslsp/omnisharp
const GLOBAL_INSTALL_DIR = join(process.env.HOME || "~", ".local", "share", "vslsp", "omnisharp");

interface PlatformInfo {
  archive: string;
  binary: string;
}

function getPlatformInfo(): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux") {
    if (arch === "x64") {
      return { archive: "omnisharp-linux-x64-net6.0.tar.gz", binary: "OmniSharp" };
    } else if (arch === "arm64") {
      return { archive: "omnisharp-linux-arm64-net6.0.tar.gz", binary: "OmniSharp" };
    }
  } else if (platform === "darwin") {
    if (arch === "x64") {
      return { archive: "omnisharp-osx-x64-net6.0.tar.gz", binary: "OmniSharp" };
    } else if (arch === "arm64") {
      return { archive: "omnisharp-osx-arm64-net6.0.tar.gz", binary: "OmniSharp" };
    }
  } else if (platform === "win32") {
    if (arch === "x64") {
      return { archive: "omnisharp-win-x64-net6.0.zip", binary: "OmniSharp.exe" };
    } else if (arch === "arm64") {
      return { archive: "omnisharp-win-arm64-net6.0.zip", binary: "OmniSharp.exe" };
    }
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function downloadAndExtract(url: string, destDir: string, isZip: boolean): Promise<void> {
  const tempFile = join(destDir, isZip ? "omnisharp.zip" : "omnisharp.tar.gz");

  console.log(`Downloading from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await Bun.write(tempFile, buffer);
  console.log(`Downloaded to ${tempFile}`);

  console.log("Extracting...");
  if (isZip) {
    await $`unzip -o ${tempFile} -d ${destDir}`.quiet();
  } else {
    await $`tar -xzf ${tempFile} -C ${destDir}`.quiet();
  }

  // Clean up archive
  await $`rm ${tempFile}`.quiet();
}

async function main() {
  const omnisharpDir = GLOBAL_INSTALL_DIR;

  try {
    const platformInfo = getPlatformInfo();
    const url = `${OMNISHARP_BASE_URL}/${platformInfo.archive}`;
    const binaryPath = join(omnisharpDir, platformInfo.binary);

    if (existsSync(binaryPath)) {
      console.log(`OmniSharp already exists at ${binaryPath}`);
      console.log("Delete the omnisharp directory to re-download.");
      return;
    }

    if (!existsSync(omnisharpDir)) {
      mkdirSync(omnisharpDir, { recursive: true });
    }

    const isZip = platformInfo.archive.endsWith(".zip");
    await downloadAndExtract(url, omnisharpDir, isZip);

    // Make binary executable on Unix
    if (process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }

    console.log(`\nOmniSharp installed successfully at ${binaryPath}`);
    console.log(`Version: ${OMNISHARP_VERSION}`);
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
}

main();
