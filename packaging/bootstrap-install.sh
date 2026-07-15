#!/usr/bin/env bash
#
# Jarvis — BARE-MACHINE bootstrap installer (Linux).
#
# Mindset: assume the device has NOTHING. This script installs every system
# dependency Jarvis needs (build tools, Qt6, LayerShellQt, libsodium, libqrencode,
# Python, Node, and the Wayland computer-use runtime tools), sets up the Python
# engine venv + the Node phone server, builds the C++ superbuild, and installs the
# desktop app + daemon. After it finishes, `systemctl --user start jarvisd` and
# launch `cindro-sidebar` — the first run shows the setup wizard.
#
# Supports: Fedora/RHEL (dnf), Debian/Ubuntu (apt), Arch (pacman), openSUSE (zypper).
# Re-runnable. Uses sudo ONLY for the system package install step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

# --- detect the package manager ----------------------------------------------
PM=""
for c in dnf apt-get pacman zypper; do command -v "$c" >/dev/null 2>&1 && { PM="$c"; break; }; done
[ -n "$PM" ] || { warn "No supported package manager (dnf/apt/pacman/zypper). Install deps manually, then run packaging/install.sh."; exit 1; }
say "Package manager: $PM"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# --- per-distro dependency sets ----------------------------------------------
# Groups: C++ build, Qt6 (Core/Gui/Quick/QuickControls2/WebSockets/Network/Multimedia/Sql),
# LayerShellQt, libsodium, libqrencode, libsecret (SecretCipher's OS-backed
# encryption of secrets.json via the Secret Service — optional at CMake
# configure time, but installed here so every fresh box gets it), python venv,
# node+npm, and computer-use runtime tools (grim, spectacle, ydotool,
# wl-clipboard, pipewire utils).
case "$PM" in
  dnf)
    PKGS=(gcc-c++ cmake ninja-build pkgconf-pkg-config
          qt6-qtbase-devel qt6-qtdeclarative-devel qt6-qtquickcontrols2-devel
          qt6-qtwebsockets-devel qt6-qtmultimedia-devel layer-shell-qt-devel
          libsodium-devel qrencode-devel libsecret-devel
          python3 python3-pip nodejs npm
          grim ydotool wl-clipboard pipewire-utils) ;;
  apt-get)
    PKGS=(build-essential cmake ninja-build pkg-config
          qt6-base-dev qt6-declarative-dev qt6-quickcontrols2-dev
          qt6-websockets-dev qt6-multimedia-dev liblayershellqtinterface-dev
          libsodium-dev libqrencode-dev libsecret-1-dev
          python3 python3-venv python3-pip nodejs npm
          grim ydotool wl-clipboard pipewire-bin) ;;
  pacman)
    PKGS=(base-devel cmake ninja qt6-base qt6-declarative qt6-quickcontrols2
          qt6-websockets qt6-multimedia layer-shell-qt libsodium qrencode libsecret
          python python-pip nodejs npm grim ydotool wl-clipboard pipewire) ;;
  zypper)
    PKGS=(gcc-c++ cmake ninja pkgconf qt6-base-devel qt6-declarative-devel
          qt6-quickcontrols2-devel qt6-websockets-devel qt6-multimedia-devel
          layer-shell-qt-devel libsodium-devel qrencode-devel libsecret-devel
          python3 python3-pip
          nodejs npm grim ydotool wl-clipboard pipewire) ;;
esac

say "Installing system dependencies (sudo may prompt)…"
case "$PM" in
  dnf)     $SUDO dnf install -y "${PKGS[@]}" ;;
  apt-get) $SUDO apt-get update && $SUDO apt-get install -y "${PKGS[@]}" ;;
  pacman)  $SUDO pacman -Sy --needed --noconfirm "${PKGS[@]}" ;;
  zypper)  $SUDO zypper install -y "${PKGS[@]}" ;;
esac

# --- /dev/uinput access for the computer-use virtual pointer ------------------
if [ -e /dev/uinput ] && ! [ -w /dev/uinput ]; then
  say "Granting your user rw on /dev/uinput (computer-use virtual mouse)…"
  $SUDO setfacl -m "u:$USER:rw" /dev/uinput 2>/dev/null || \
    warn "Could not setfacl /dev/uinput — computer-use mouse may need: sudo setfacl -m u:\$USER:rw /dev/uinput"
fi

# --- Python computer-use engine venv -----------------------------------------
say "Setting up the computer-use engine venv…"
( cd "$REPO_ROOT/computer-use" && env -u PYTHONPATH python3 -m venv .venv \
  && env -u PYTHONPATH .venv/bin/pip install -q -e . )

# --- Node phone server -------------------------------------------------------
if [ -d "$REPO_ROOT/phone/server" ]; then
  say "Building the phone server…"
  ( cd "$REPO_ROOT/phone/server" && npm ci --omit=dev && npm run build ) || \
    warn "phone server build skipped/failed (optional subsystem)."
fi

# --- C++ superbuild + install ------------------------------------------------
say "Building Jarvis (C++ superbuild)…"
env -u PYTHONPATH cmake -S "$REPO_ROOT" -B "$REPO_ROOT/build" -G Ninja
env -u PYTHONPATH cmake --build "$REPO_ROOT/build"

say "Installing app + daemon + units…"
"$REPO_ROOT/packaging/install.sh"

cat <<EOF

$(printf '\033[1;32m✓ Jarvis installed.\033[0m')
  start the daemon:   systemctl --user start jarvisd
  launch the UI:      cindro-sidebar         (first run = setup wizard)
  no Codex/Claude CLI? paste a Mistral key in Settings → see docs/MISTRAL_SETUP.md
EOF
