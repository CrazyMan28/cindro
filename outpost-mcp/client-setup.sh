#!/usr/bin/env bash
# Register the Outpost-MCP endpoint with Claude Code (~/.claude.json) and Codex
# (~/.codex/config.toml) so either agent can pair machines + run exec/screenshot.
#   ./client-setup.sh            # print snippets
#   ./client-setup.sh --apply    # patch both
set -euo pipefail

NAME="outpost"
HOST="${OUTPOST_MCP_ADVERTISE_HOST:-127.0.0.1}"
PORT="${OUTPOST_MCP_PORT:-8798}"
URL="http://${HOST}:${PORT}/mcp"
TOKEN_FILE="${HOME}/.config/jarvis/outpost_mcp_token"
CODEX_ENV_VAR="OUTPOST_MCP_TOKEN"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "WARN: $TOKEN_FILE not found — start outpost-mcp once (it auto-generates a" \
       "0600 token), or set OUTPOST_MCP_TOKEN in the environment." >&2
  TOKEN="<RUN-THE-SERVER-ONCE-TO-GENERATE>"
else
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
fi

CLAUDE_JSON="${HOME}/.claude.json"
CODEX_TOML="${HOME}/.codex/config.toml"

print_snippets() {
  cat <<EOF
# Outpost-MCP endpoint: ${URL}
# --- Claude Code: ~/.claude.json -> mcpServers.${NAME} ----------------------
{
  "mcpServers": {
    "${NAME}": { "type": "http", "url": "${URL}",
      "headers": { "Authorization": "Bearer ${TOKEN}" } }
  }
}
# --- Codex CLI: ~/.codex/config.toml ----------------------------------------
[mcp_servers.${NAME}]
url = "${URL}"
bearer_token_env_var = "${CODEX_ENV_VAR}"
#   export ${CODEX_ENV_VAR}="\$(cat ${TOKEN_FILE})"
EOF
}

patch_claude() {
  [[ -f "$CLAUDE_JSON" ]] || echo "{}" > "$CLAUDE_JSON"
  NAME="$NAME" URL="$URL" TOKEN="$TOKEN" CLAUDE_JSON="$CLAUDE_JSON" python3 - <<'PY'
import json, os
path = os.environ["CLAUDE_JSON"]
with open(path) as f:
    data = json.load(f)
data.setdefault("mcpServers", {})
data["mcpServers"][os.environ["NAME"]] = {
    "type": "http", "url": os.environ["URL"],
    "headers": {"Authorization": "Bearer " + os.environ["TOKEN"]}}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
print(f"patched {path}: mcpServers.{os.environ['NAME']}")
PY
}

patch_codex() {
  mkdir -p "$(dirname "$CODEX_TOML")"; touch "$CODEX_TOML"
  NAME="$NAME" URL="$URL" CODEX_ENV_VAR="$CODEX_ENV_VAR" CODEX_TOML="$CODEX_TOML" python3 - <<'PY'
import os, re
path = os.environ["CODEX_TOML"]; name = os.environ["NAME"]
with open(path) as f:
    txt = f.read()
block = (f"[mcp_servers.{name}]\n"
         f'url = "{os.environ["URL"]}"\n'
         f'bearer_token_env_var = "{os.environ["CODEX_ENV_VAR"]}"\n')
pattern = re.compile(r"^\[mcp_servers\." + re.escape(name) + r"\].*?(?=^\[|\Z)",
                     re.MULTILINE | re.DOTALL)
txt = pattern.sub(block.rstrip() + "\n", txt) if pattern.search(txt) else (
    (txt + ("\n" if txt and not txt.endswith("\n") else "")) + "\n" + block)
with open(path, "w") as f:
    f.write(txt)
print(f"patched {path}: [mcp_servers.{name}]")
PY
}

case "${1:-}" in
  --apply)  patch_claude; patch_codex ;;
  --claude) patch_claude ;;
  --codex)  patch_codex ;;
  ""|--print|-h|--help) print_snippets ;;
  *) echo "unknown arg: $1" >&2; print_snippets; exit 2 ;;
esac
