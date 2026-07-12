#!/usr/bin/env bash
#
# Cindro installer — builds the C++ superbuild and installs the desktop app,
# daemon, icon, .desktop launcher, systemd --user unit, and a Sway keybind
# snippet into the user's ~/.local and ~/.config trees.
#
# NO sudo. Everything lands under $HOME. Idempotent: re-running re-builds and
# overwrites the installed copies in place.
#
set -euo pipefail

# --- Paths -------------------------------------------------------------------
# Repo root = the parent of this script's packaging/ dir (works from any clone).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build"
PKG_DIR="${REPO_ROOT}/packaging"

BIN_DIR="${HOME}/.local/bin"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
APP_DIR="${HOME}/.local/share/applications"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
SWAY_CONF_D="${HOME}/.config/sway/config.d"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# --- 1. Build the C++ superbuild --------------------------------------------
log "Configuring superbuild (cmake -G Ninja)..."
cmake -S "${REPO_ROOT}" -B "${BUILD_DIR}" -G Ninja

log "Building (cmake --build)..."
cmake --build "${BUILD_DIR}"

# --- 2. Install the binaries -------------------------------------------------
log "Installing binaries into ${BIN_DIR}..."
mkdir -p "${BIN_DIR}"
install -m 0755 "${BUILD_DIR}/daemon/jarvisd"          "${BIN_DIR}/jarvisd"
install -m 0755 "${BUILD_DIR}/desktop/cindro-sidebar"  "${BIN_DIR}/cindro-sidebar"
rm -f "${BIN_DIR}/jarvis-sidebar"  # stale pre-rebrand binary — doesn't self-clean

# --- 3. Install the scalable icon -------------------------------------------
log "Installing icon into ${ICON_DIR}..."
mkdir -p "${ICON_DIR}"
install -m 0644 "${PKG_DIR}/cindro.svg" "${ICON_DIR}/cindro.svg"
rm -f "${ICON_DIR}/jarvis.svg"  # stale pre-rebrand icon

# --- 4. Install the .desktop launcher (substitute __HOME__) ------------------
log "Installing desktop entry into ${APP_DIR}..."
mkdir -p "${APP_DIR}"
sed "s|__HOME__|${HOME}|g" "${PKG_DIR}/cindro.desktop" > "${APP_DIR}/cindro.desktop"
chmod 0644 "${APP_DIR}/cindro.desktop"
rm -f "${APP_DIR}/jarvis.desktop"  # stale pre-rebrand launcher entry

log "Refreshing desktop & icon caches (best-effort)..."
update-desktop-database "${APP_DIR}" 2>/dev/null || true
gtk-update-icon-cache "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true

# --- 5. Install the systemd --user unit -------------------------------------
log "Installing systemd --user unit into ${SYSTEMD_USER_DIR}..."
mkdir -p "${SYSTEMD_USER_DIR}"
install -m 0644 "${PKG_DIR}/jarvisd.service" "${SYSTEMD_USER_DIR}/jarvisd.service"

# --- 6. Install the Sway keybind snippet ------------------------------------
# We only DROP a file into config.d — we never touch the user's main sway
# config. A sway config that `include`s config.d/* picks this up on reload.
log "Installing Sway keybind snippet into ${SWAY_CONF_D}..."
mkdir -p "${SWAY_CONF_D}"
cat > "${SWAY_CONF_D}/90-cindro.conf" <<'EOF'
bindsym $mod+j exec ~/.local/bin/cindro-sidebar --toggle
EOF
rm -f "${SWAY_CONF_D}/90-jarvis.conf"  # stale pre-rebrand snippet

# --- 6b. Install the Chrome/Edge extension (unpacked) -----------------------
# Chrome blocks silent installs of unpacked extensions, so we stage it at a
# stable path and the in-app "Add the Chrome extension" guide walks you through
# loading it (chrome://extensions → Developer mode → Load unpacked → this folder).
EXT_DIR="${HOME}/.local/share/jarvis/extension"
log "Installing the Chrome extension into ${EXT_DIR}..."
mkdir -p "${EXT_DIR}"
cp -r "${REPO_ROOT}/extension/." "${EXT_DIR}/"

# --- 6c. Install the web console (Bun+Vite+SolidJS dashboard) ---------------
# Stage it, then run it with: cindro web start   (http://127.0.0.1:8788)
# rm -rf first (not just `cp -r` over the top): the dashboard was previously
# plain static files (app.js/style.css/serve.py) — an old install left those
# behind alongside the new src/ tree otherwise, which is confusing to debug.
WEB_DIR="${HOME}/.local/share/jarvis/web"
log "Installing the web console into ${WEB_DIR}..."
rm -rf "${WEB_DIR}"
mkdir -p "${WEB_DIR}"
cp -r "${REPO_ROOT}/web/." "${WEB_DIR}/"
# Never ship a dev checkout's build artifacts — `cindro web start` does its
# own `bun install`/`bun run build` fresh, and a stale/wrong-platform
# node_modules copied in from the source machine could break that.
rm -rf "${WEB_DIR}/node_modules" "${WEB_DIR}/dist"
if ! command -v bun >/dev/null 2>&1; then
  log "WARNING: bun not found on PATH — 'cindro web start' needs it to build/serve the dashboard. Install from https://bun.sh"
fi

# --- 6d. Install the cindro CLI (terminal agent + doctor/status) -------------
# Own venv under the data dir (the engine venv stays untouched); `cindro` goes
# on PATH next to jarvisd. Skipped gracefully when python3-venv is missing.
CLI_VENV="${HOME}/.local/share/jarvis/cli-venv"
if [ -d "${REPO_ROOT}/cli" ]; then
  log "Installing the cindro CLI into ${CLI_VENV}..."
  if env -u PYTHONPATH python3 -m venv "${CLI_VENV}" 2>/dev/null; then
    env -u PYTHONPATH "${CLI_VENV}/bin/pip" install -q --upgrade "${REPO_ROOT}/cli" \
      && ln -sf "${CLI_VENV}/bin/cindro" "${HOME}/.local/bin/cindro" \
      || log "WARNING: cindro CLI install failed (pip); skipping"
  else
    log "WARNING: python3 -m venv unavailable; skipping the cindro CLI"
  fi
fi

# --- 6.5 outpost-agent binaries ---------------------------------------------
# The compiled outpost-agent binaries (outpost-mcp/agent-bin/) are gitignored, so
# a from-source install has none and every outpost pairing 404s. Pre-build them
# once here if a Go toolchain is present (the server can also build on demand,
# but paying it at install keeps the first pairing fast).
if [ -x "${REPO_ROOT}/outpost-agent/build.sh" ] && command -v go >/dev/null 2>&1; then
  log "Building outpost-agent binaries (Go found)..."
  ( cd "${REPO_ROOT}/outpost-agent" && ./build.sh ) >/dev/null 2>&1 \
    && log "outpost-agent binaries built into outpost-mcp/agent-bin/" \
    || log "WARNING: outpost-agent build failed; the server will build on demand"
fi

# --- 7. Next steps -----------------------------------------------------------
cat <<EOF

$(log "Cindro installed.")

Next steps:
  1. Start the daemon (and enable it at login):
       systemctl --user enable --now jarvisd
     (or from any terminal:  cindro start · cindro status · cindro doctor —
      and plain \`cindro\` opens the full terminal agent)

  Chrome/Edge extension (optional — for the in-browser agent + side panel):
       open chrome://extensions  →  enable "Developer mode"  →  "Load unpacked"
       →  select:  ${EXT_DIR}
     (The Jarvis app also shows this under Settings → "Add the Chrome extension".)

  2. Sway: reload your config to pick up the \$mod+j keybind:
       swaymsg reload
     (Make sure your sway config includes config.d, e.g.:
        include ~/.config/sway/config.d/*.conf )

  3. KDE: Jarvis now appears in the application launcher.
     Search "Jarvis", then right-click its icon and choose
     "Pin to Task Manager" (or "Add to Panel") to keep it on the taskbar.

EOF
