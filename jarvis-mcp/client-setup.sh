#!/usr/bin/env bash
# Register the Jarvis-MCP server with Claude Code (~/.claude.json) and Codex
# (~/.codex/config.toml) so either agent can drive Jarvis + computer-use through
# this one endpoint.
#
#   ./client-setup.sh            # print the snippets (no changes)
#   ./client-setup.sh --apply    # patch ~/.claude.json AND ~/.codex/config.toml
#   ./client-setup.sh --claude   # patch only ~/.claude.json
#   ./client-setup.sh --codex    # patch only ~/.codex/config.toml
#
# Idempotent: re-running replaces the existing "jarvis" entry in place.
set -euo pipefail

NAME="jarvis"
HOST="${JARVIS_MCP_ADVERTISE_HOST:-100.114.201.41}"
PORT="${JARVIS_MCP_PORT:-8797}"
URL="http://${HOST}:${PORT}/mcp"
TOKEN_FILE="${HOME}/.config/jarvis/jarvis_mcp_token"
CODEX_ENV_VAR="JARVIS_MCP_TOKEN"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "WARN: $TOKEN_FILE not found — start the server once (it auto-generates" \
       "a 0600 token), or set JARVIS_MCP_TOKEN in the environment." >&2
  TOKEN="<RUN-THE-SERVER-ONCE-TO-GENERATE>"
else
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
fi

CLAUDE_JSON="${HOME}/.claude.json"
CODEX_TOML="${HOME}/.codex/config.toml"

print_snippets() {
  cat <<EOF
# ============================================================================
# Jarvis-MCP endpoint: ${URL}
# ============================================================================

# --- Claude Code: ~/.claude.json -> mcpServers.${NAME} ----------------------
{
  "mcpServers": {
    "${NAME}": {
      "type": "http",
      "url": "${URL}",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}

# --- Codex CLI: ~/.codex/config.toml ----------------------------------------
[mcp_servers.${NAME}]
url = "${URL}"
bearer_token_env_var = "${CODEX_ENV_VAR}"
# then export the token for codex (e.g. in ~/.zshrc):
#   export ${CODEX_ENV_VAR}="\$(cat ${TOKEN_FILE})"
EOF
}

patch_claude() {
  if [[ ! -f "$CLAUDE_JSON" ]]; then
    echo "{}" > "$CLAUDE_JSON"
  fi
  NAME="$NAME" URL="$URL" TOKEN="$TOKEN" CLAUDE_JSON="$CLAUDE_JSON" python3 - <<'PY'
import json, os
path = os.environ["CLAUDE_JSON"]
with open(path) as f:
    data = json.load(f)
data.setdefault("mcpServers", {})
data["mcpServers"][os.environ["NAME"]] = {
    "type": "http",
    "url": os.environ["URL"],
    "headers": {"Authorization": "Bearer " + os.environ["TOKEN"]},
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
print(f"patched {path}: mcpServers.{os.environ['NAME']}")
PY
}

patch_codex() {
  mkdir -p "$(dirname "$CODEX_TOML")"
  touch "$CODEX_TOML"
  NAME="$NAME" URL="$URL" CODEX_ENV_VAR="$CODEX_ENV_VAR" CODEX_TOML="$CODEX_TOML" \
    python3 - <<'PY'
import os, re
path = os.environ["CODEX_TOML"]
name = os.environ["NAME"]
with open(path) as f:
    txt = f.read()
header = f"[mcp_servers.{name}]"
block = (
    f"{header}\n"
    f'url = "{os.environ["URL"]}"\n'
    f'bearer_token_env_var = "{os.environ["CODEX_ENV_VAR"]}"\n'
)
# Replace an existing [mcp_servers.<name>] block (up to the next [section] or EOF).
pattern = re.compile(
    r"^\[mcp_servers\." + re.escape(name) + r"\].*?(?=^\[|\Z)",
    re.MULTILINE | re.DOTALL,
)
if pattern.search(txt):
    txt = pattern.sub(block.rstrip() + "\n", txt)
else:
    if txt and not txt.endswith("\n"):
        txt += "\n"
    txt += "\n" + block
with open(path, "w") as f:
    f.write(txt)
print(f"patched {path}: [mcp_servers.{name}]")
print(f"  remember to export {os.environ['CODEX_ENV_VAR']} for codex:")
print(f'    export {os.environ["CODEX_ENV_VAR"]}="$(cat {os.path.expanduser("~/.config/jarvis/jarvis_mcp_token")})"')
PY
}

case "${1:-}" in
  --apply)  patch_claude; patch_codex ;;
  --claude) patch_claude ;;
  --codex)  patch_codex ;;
  ""|--print|-h|--help) print_snippets ;;
  *) echo "unknown arg: $1" >&2; print_snippets; exit 2 ;;
esac
