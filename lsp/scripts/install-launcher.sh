#!/bin/sh
# Installs a launcher named `opencode-review-lsp` on PATH that runs the bundled language
# server. The Zed extension locates the server via `worktree.which("opencode-review-lsp")`
# because Zed does not copy the repo's lsp/ folder into its extension work dir.
set -e

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SERVER="$REPO_ROOT/lsp/dist/server.js"

if [ ! -f "$SERVER" ]; then
  echo "Building the language server bundle first..."
  (cd "$REPO_ROOT/lsp" && bun run build)
fi

# Prefer bun, fall back to node.
RUNTIME=$(command -v bun || command -v node || true)
if [ -z "$RUNTIME" ]; then
  echo "error: need bun or node on PATH" >&2
  exit 1
fi

# Pick a PATH dir we can write to.
for d in "$HOME/.local/bin" "$HOME/.bun/bin" "/usr/local/bin"; do
  case ":$PATH:" in *":$d:"*) BINDIR="$d"; break;; esac
done
: "${BINDIR:=$HOME/.local/bin}"
mkdir -p "$BINDIR"

LAUNCHER="$BINDIR/opencode-review-lsp"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$RUNTIME" "$SERVER" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "Installed launcher: $LAUNCHER"
echo "  -> $RUNTIME $SERVER"
