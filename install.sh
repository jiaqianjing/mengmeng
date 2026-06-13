#!/usr/bin/env sh
set -eu

REPO_RAW_URL="${MENGMENG_RAW_URL:-https://raw.githubusercontent.com/jiaqianjing/mengmeng/main/bin/mm.js}"
BIN_DIR="${MENGMENG_INSTALL_DIR:-$HOME/.local/bin}"
FORCE=0

usage() {
  cat <<'EOF'
MengMeng installer

Usage:
  sh install.sh [--bin-dir DIR] [--force]

Environment:
  MENGMENG_INSTALL_DIR  Install directory, defaults to ~/.local/bin
  MENGMENG_RAW_URL      Override download URL for bin/mm.js
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      shift
      [ "$#" -gt 0 ] || { echo "missing value for --bin-dir" >&2; exit 1; }
      BIN_DIR="$1"
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required, but node was not found." >&2
  echo "Install Node first, then rerun this installer." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Found: $(node -v)" >&2
  exit 1
fi

TARGET="$BIN_DIR/mm"
if [ -e "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  echo "$TARGET already exists." >&2
  echo "Rerun with --force to overwrite it." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

TMP_FILE="$(mktemp)"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_RAW_URL" -o "$TMP_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_FILE" "$REPO_RAW_URL"
else
  echo "curl or wget is required to download MengMeng." >&2
  exit 1
fi

chmod +x "$TMP_FILE"
mv "$TMP_FILE" "$TARGET"
trap - EXIT

echo "MengMeng installed: $TARGET"
if ! command -v mm >/dev/null 2>&1; then
  echo
  echo "Add this to your shell profile if mm is not found:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi
echo
echo "Next:"
echo "  mm init"
echo "  mm add kimi"
