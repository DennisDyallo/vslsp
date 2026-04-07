#!/usr/bin/env bash
set -euo pipefail

# vslsp installer - Downloads compiled binary and OmniSharp

REPO="DennisDyallo/vslsp"
OMNISHARP_VERSION="v1.39.11"
INSTALL_DIR="$HOME/.local/share/vslsp"
BIN_DIR="$HOME/.local/bin"

# Parse installer flags
MAPPERS=""
YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mappers=*) MAPPERS="${1#--mappers=}"; shift ;;
    --mappers)   [[ $# -ge 2 ]] || error "--mappers requires a value"; MAPPERS="$2"; shift 2 ;;
    --yes|-y)    YES=true; shift ;;
    *)           shift ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Detect platform
detect_platform() {
    local os arch
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"

    case "$os" in
        linux) os="linux" ;;
        darwin) os="darwin" ;;
        *) error "Unsupported OS: $os" ;;
    esac

    case "$arch" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) error "Unsupported architecture: $arch" ;;
    esac

    echo "${os}-${arch}"
}

# Check for .NET runtime
check_dotnet() {
    if command -v dotnet &> /dev/null; then
        local version
        version=$(dotnet --version 2>/dev/null || echo "unknown")
        info ".NET runtime found: $version"
    else
        warn ".NET runtime not found. OmniSharp requires .NET 6.0+"
        warn "Install from: https://dotnet.microsoft.com/download"
        echo ""
    fi
}

# Get latest release version from GitHub
get_latest_version() {
    local url="https://api.github.com/repos/${REPO}/releases/latest"
    if command -v curl &> /dev/null; then
        curl -fsSL "$url" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
    elif command -v wget &> /dev/null; then
        wget -qO- "$url" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
    else
        error "Neither curl nor wget found"
    fi
}

# Download file
download() {
    local url="$1" dest="$2"
    if command -v curl &> /dev/null; then
        curl -fsSL "$url" -o "$dest"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$dest"
    else
        error "Neither curl nor wget found"
    fi
}

# Download vslsp binary
download_vslsp() {
    local platform="$1" version="$2"
    local binary_name="vslsp-${platform}"
    local url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"

    info "Downloading vslsp ${version} for ${platform}..."
    mkdir -p "$INSTALL_DIR"
    download "$url" "$INSTALL_DIR/vslsp"
    chmod +x "$INSTALL_DIR/vslsp"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        xattr -dr com.apple.quarantine "$INSTALL_DIR/vslsp" 2>/dev/null || true
    fi
    info "vslsp binary installed to $INSTALL_DIR/vslsp"
}

# Download vslsp-mcp binary
download_vslsp_mcp() {
    local platform="$1" version="$2"
    local binary_name="vslsp-mcp-${platform}"
    local url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"

    info "Downloading vslsp-mcp ${version} for ${platform}..."
    mkdir -p "$INSTALL_DIR"
    download "$url" "$INSTALL_DIR/vslsp-mcp"
    chmod +x "$INSTALL_DIR/vslsp-mcp"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        xattr -dr com.apple.quarantine "$INSTALL_DIR/vslsp-mcp" 2>/dev/null || true
    fi
    info "vslsp-mcp binary installed to $INSTALL_DIR/vslsp-mcp"
}

# Download OmniSharp
download_omnisharp() {
    local platform="$1"
    local omnisharp_dir="$INSTALL_DIR/omnisharp"
    local archive_name
    local os_part arch_part

    # Parse platform
    os_part="${platform%-*}"
    arch_part="${platform#*-}"

    # Map to OmniSharp naming
    case "$os_part" in
        darwin) os_part="osx" ;;
    esac

    archive_name="omnisharp-${os_part}-${arch_part}-net6.0.tar.gz"
    local url="https://github.com/OmniSharp/omnisharp-roslyn/releases/download/${OMNISHARP_VERSION}/${archive_name}"

    info "Downloading OmniSharp ${OMNISHARP_VERSION}..."
    mkdir -p "$omnisharp_dir"

    local tmp_archive
    tmp_archive="$(mktemp)"
    download "$url" "$tmp_archive"

    info "Extracting OmniSharp..."
    tar -xzf "$tmp_archive" -C "$omnisharp_dir"
    rm -f "$tmp_archive"

    chmod +x "$omnisharp_dir/OmniSharp"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        xattr -dr com.apple.quarantine "$omnisharp_dir/OmniSharp" 2>/dev/null || true
    fi
    info "OmniSharp installed to $omnisharp_dir/OmniSharp"
}

# Download CSharpMapper
download_csharp_mapper() {
    local platform="$1" version="$2"
    local binary_name="CSharpMapper-${platform}"
    local url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"
    local csharp_mapper_dir="$INSTALL_DIR/csharp-mapper"

    info "Downloading CSharpMapper for ${platform}..."
    mkdir -p "$csharp_mapper_dir"
    download "$url" "$csharp_mapper_dir/CSharpMapper"
    chmod +x "$csharp_mapper_dir/CSharpMapper"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        xattr -dr com.apple.quarantine "$csharp_mapper_dir/CSharpMapper" 2>/dev/null || true
    fi
    info "CSharpMapper installed to $csharp_mapper_dir/CSharpMapper"
}

# Download RustMapper
download_rust_mapper() {
    local platform="$1" version="$2"
    local url="https://github.com/${REPO}/releases/download/${version}/RustMapper-${platform}"
    local rust_mapper_dir="$INSTALL_DIR/rust-mapper"

    info "Downloading RustMapper for ${platform}..."
    mkdir -p "$rust_mapper_dir"
    download "$url" "$rust_mapper_dir/RustMapper"
    chmod +x "$rust_mapper_dir/RustMapper"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        xattr -dr com.apple.quarantine "$rust_mapper_dir/RustMapper" 2>/dev/null || true
    fi
    info "RustMapper installed to $rust_mapper_dir/RustMapper"
}

# Download TSMapper
download_ts_mapper() {
    local platform="$1" version="$2"
    local url="https://github.com/${REPO}/releases/download/${version}/TSMapper-${platform}"
    local ts_mapper_dir="$INSTALL_DIR/ts-mapper"

    info "Downloading TSMapper for ${platform}..."
    mkdir -p "$ts_mapper_dir"
    download "$url" "$ts_mapper_dir/TSMapper"
    chmod +x "$ts_mapper_dir/TSMapper"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        xattr -dr com.apple.quarantine "$ts_mapper_dir/TSMapper" 2>/dev/null || true
    fi
    info "TSMapper installed to $ts_mapper_dir/TSMapper"
}

# Interactively select mappers (called when MAPPERS is unset and stdin is a TTY)
select_mappers_interactive() {
    echo ""
    echo "Which code mappers would you like to install?"
    echo "  C# (CSharpMapper) is always included."
    echo "  [2] Rust / syn      (RustMapper)"
    echo "  [3] TypeScript      (TSMapper)"
    echo ""
    read -r -p "Enter additional mappers (e.g. 2 3), 'all', or ENTER for C# only: " selection
    MAPPERS="csharp"
    if [[ "$selection" == "all" ]]; then
        MAPPERS="csharp,rust,typescript"
    else
        [[ "$selection" == *"2"* ]] && MAPPERS="$MAPPERS,rust"
        [[ "$selection" == *"3"* ]] && MAPPERS="$MAPPERS,typescript"
    fi
}

# Create symlink in ~/.local/bin
create_symlink() {
    mkdir -p "$BIN_DIR"

    if [[ -L "$BIN_DIR/vslsp" ]]; then
        rm "$BIN_DIR/vslsp"
    elif [[ -e "$BIN_DIR/vslsp" ]]; then
        warn "Existing file at $BIN_DIR/vslsp, backing up..."
        mv "$BIN_DIR/vslsp" "$BIN_DIR/vslsp.bak"
    fi

    ln -s "$INSTALL_DIR/vslsp" "$BIN_DIR/vslsp"
    info "Created symlink: $BIN_DIR/vslsp -> $INSTALL_DIR/vslsp"

    # vslsp-mcp symlink
    if [[ -L "$BIN_DIR/vslsp-mcp" ]]; then
        rm "$BIN_DIR/vslsp-mcp"
    elif [[ -e "$BIN_DIR/vslsp-mcp" ]]; then
        mv "$BIN_DIR/vslsp-mcp" "$BIN_DIR/vslsp-mcp.bak"
    fi

    ln -s "$INSTALL_DIR/vslsp-mcp" "$BIN_DIR/vslsp-mcp"
    info "Created symlink: $BIN_DIR/vslsp-mcp -> $INSTALL_DIR/vslsp-mcp"

    # Check if ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        warn "$BIN_DIR is not in your PATH"
        warn "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo ""
        echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
    fi
}

# Register MCP server in ~/.claude.json (Claude Code's global MCP config)
configure_mcp() {
    local claude_config="$HOME/.claude.json"
    if command -v python3 &> /dev/null; then
        python3 - <<PYEOF
import json, os, sys
path = os.path.expanduser("$claude_config")
config = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            config = json.load(f)
    except Exception:
        pass
config.setdefault("mcpServers", {})["vslsp"] = {
    "type": "stdio",
    "command": "$BIN_DIR/vslsp-mcp",
    "args": []
}
with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
print("[INFO] MCP server registered in ~/.claude.json")
PYEOF
    else
        warn "python3 not found — skipping MCP registration. Add vslsp manually to ~/.claude.json mcpServers."
    fi
}

# Install vslsp as a Claude Code custom slash command (/vslsp)
# Works in any Claude Code instance — no additional framework required.
install_skill() {
    local skill_url="https://raw.githubusercontent.com/${REPO}/main/skills/vslsp/SKILL.md"
    local commands_dir="$HOME/.claude/commands"
    local skill_dst="$commands_dir/vslsp.md"

    if [[ ! -d "$HOME/.claude" ]]; then
        # Claude Code not installed — skip silently
        return
    fi

    mkdir -p "$commands_dir"
    if download "$skill_url" "$skill_dst" 2>/dev/null; then
        info "Claude Code /vslsp command installed to $skill_dst"
    else
        warn "Could not download Claude Code /vslsp command — skipping"
    fi
}

# Verify installation
verify_install() {
    info "Verifying installation..."
    if "$INSTALL_DIR/vslsp" --help &> /dev/null; then
        info "vslsp installed successfully!"
    else
        error "Installation verification failed"
    fi
}

main() {
    echo ""
    echo "================================"
    echo "  vslsp Installer"
    echo "================================"
    echo ""

    local platform version
    platform="$(detect_platform)"
    info "Detected platform: $platform"

    check_dotnet

    version="$(get_latest_version)"
    if [[ -z "$version" ]]; then
        error "Could not determine latest version"
    fi
    info "Latest version: $version"

    download_vslsp "$platform" "$version"
    download_vslsp_mcp "$platform" "$version"
    download_omnisharp "$platform"

    # Resolve which mappers to install
    if [[ -z "$MAPPERS" ]]; then
        if [[ "$YES" == "true" ]] || ! [ -t 0 ]; then
            MAPPERS="csharp"
        else
            select_mappers_interactive
        fi
    fi
    [[ "$MAPPERS" == "all" ]] && MAPPERS="csharp,rust,typescript"
    [[ "$MAPPERS" == "none" ]] && MAPPERS=""

    [[ "$MAPPERS" == *"csharp"*      ]] && download_csharp_mapper "$platform" "$version"
    [[ "$MAPPERS" == *"rust"*        ]] && download_rust_mapper "$platform" "$version"
    [[ "$MAPPERS" == *"typescript"*  ]] && download_ts_mapper "$platform" "$version"

    create_symlink
    configure_mcp
    install_skill
    verify_install

    echo ""
    echo "================================"
    echo "  Installation complete!"
    echo "================================"
    echo ""
    echo "Run 'vslsp --help' to get started."
    echo ""
}

main "$@"
