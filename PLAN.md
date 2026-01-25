# Plan: vslsp One-Liner Install with Compiled Binary

## Goal
Create a distribution system where users install vslsp with:
```bash
curl -fsSL https://raw.githubusercontent.com/<user>/vslsp/main/install.sh | bash
```

No Bun, Node, or git required at runtime - just download and run.

## User Requirements
- **Distribution**: Compiled standalone binary via `bun build --compile`
- **.NET handling**: Check and warn only
- **Global access**: Symlink to `~/.local/bin`

---

## Implementation

### 1. GitHub Actions Workflow: `.github/workflows/release.yml`

Triggers on version tags (e.g., `v1.0.0`). Builds binaries for:
- `linux-x64`
- `linux-arm64`
- `darwin-x64` (macOS Intel)
- `darwin-arm64` (macOS Apple Silicon)

Build command:
```bash
bun build --compile --minify --target=bun-linux-x64 vslsp.ts --outfile vslsp-linux-x64
```

Uploads binaries as release assets.

### 2. Install Script: `install.sh`

The script will:

1. **Detect platform** (linux/darwin, x64/arm64)

2. **Check .NET runtime** - Warn with install instructions if missing

3. **Download vslsp binary**
   - Fetch latest release from GitHub API
   - Download platform-specific binary to `~/.local/share/vslsp/vslsp`

4. **Download OmniSharp** (reuse existing logic from `scripts/download-omnisharp.ts`)
   - Download to `~/.local/share/vslsp/omnisharp/OmniSharp`

5. **Create global command**
   - Symlink `~/.local/share/vslsp/vslsp` to `~/.local/bin/vslsp`
   - Warn if `~/.local/bin` not in PATH

6. **Verify installation**
   - Run `vslsp --help`

### Directory Structure After Install
```
~/.local/
├── bin/
│   └── vslsp -> ../share/vslsp/vslsp  (symlink)
└── share/
    └── vslsp/
        ├── vslsp           (compiled binary, ~90MB)
        └── omnisharp/
            └── OmniSharp   (OmniSharp binary)
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `install.sh` | Main installer script - detects platform, downloads binary + OmniSharp |
| `.github/workflows/release.yml` | GitHub Actions to build binaries on release |

## Files to Modify

| File | Change |
|------|--------|
| `vslsp.ts` | Update default OmniSharp path to `~/.local/share/vslsp/omnisharp/OmniSharp` (already correct) |

---

## Verification

### Test locally before pushing:
```bash
# Build binary locally
bun build --compile --minify vslsp.ts --outfile dist/vslsp

# Test it works
./dist/vslsp --help
./dist/vslsp serve --solution /path/to/Solution.sln
```

### Test installer:
```bash
# Clean install
rm -rf ~/.local/share/vslsp ~/.local/bin/vslsp

# Run installer
bash install.sh

# Verify
vslsp --help
vslsp serve --solution /path/to/Solution.sln &
vslsp query --summary
```

### Test GitHub Actions:
1. Push to repo with workflow
2. Create a tag: `git tag v0.1.0 && git push --tags`
3. Verify release has binaries for all platforms
4. Test installer downloads from release

---

## OmniSharp Download Logic Reference

From `scripts/download-omnisharp.ts`:
- Version: `v1.39.11`
- Base URL: `https://github.com/OmniSharp/omnisharp-roslyn/releases/download/`
- Platform mappings:
  - `linux-x64` → `omnisharp-linux-x64-net6.0.tar.gz`
  - `linux-arm64` → `omnisharp-linux-arm64-net6.0.tar.gz`
  - `darwin-x64` → `omnisharp-osx-x64-net6.0.tar.gz`
  - `darwin-arm64` → `omnisharp-osx-arm64-net6.0.tar.gz`
- Extract with `tar -xzf` on Unix
- Make executable: `chmod +x OmniSharp`
