# Source this file from Bash before running project commands.
UNITREE_PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
UNITREE_TOOLS_DIR="$HOME/.local/share/unitree-dev"
export PATH="$HOME/.local/bin:$UNITREE_TOOLS_DIR/python/bin:$PATH"
export PLAYWRIGHT_MODULE="$UNITREE_TOOLS_DIR/browser/node_modules/playwright"
export NOCLIP_REFERENCE="$(dirname -- "$UNITREE_PROJECT_ROOT")/noclip.website"
export BASE_URL="${BASE_URL:-http://127.0.0.1:5176}"
