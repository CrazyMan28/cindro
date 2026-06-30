#!/usr/bin/env bash
#
# Jarvis installer — builds the C++ superbuild and installs the desktop app,
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
install -m 0755 "${BUILD_DIR}/desktop/jarvis-sidebar"  "${BIN_DIR}/jarvis-sidebar"

# --- 3. Install the scalable icon -------------------------------------------
log "Installing icon into ${ICON_DIR}..."
mkdir -p "${ICON_DIR}"
install -m 0644 "${PKG_DIR}/jarvis.svg" "${ICON_DIR}/jarvis.svg"

# --- 4. Install the .desktop launcher (substitute __HOME__) ------------------
log "Installing desktop entry into ${APP_DIR}..."
mkdir -p "${APP_DIR}"
sed "s|__HOME__|${HOME}|g" "${PKG_DIR}/jarvis.desktop" > "${APP_DIR}/jarvis.desktop"
chmod 0644 "${APP_DIR}/jarvis.desktop"

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
cat > "${SWAY_CONF_D}/90-jarvis.conf" <<'EOF'
bindsym $mod+j exec ~/.local/bin/jarvis-sidebar --toggle
EOF

# --- 6b. Install the Chrome/Edge extension (unpacked) -----------------------
# Chrome blocks silent installs of unpacked extensions, so we stage it at a
# stable path and the in-app "Add the Chrome extension" guide walks you through
# loading it (chrome://extensions → Developer mode → Load unpacked → this folder).
EXT_DIR="${HOME}/.local/share/jarvis/extension"
log "Installing the Chrome extension into ${EXT_DIR}..."
mkdir -p "${EXT_DIR}"
cp -r "${REPO_ROOT}/extension/." "${EXT_DIR}/"

# --- 7. Next steps -----------------------------------------------------------
cat <<EOF

$(log "Jarvis installed.")

Next steps:
  1. Start the daemon (and enable it at login):
       systemctl --user enable --now jarvisd

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
