#!/usr/bin/env bash
#
# Build a portable Jarvis .AppImage (Linux release artifact).
#
#   packaging/build-appimage.sh [version]      -> dist/Jarvis-<version>-x86_64.AppImage
#
# Bundles jarvisd + jarvis-sidebar + Qt6 + LayerShellQt + libsodium (via
# linuxdeploy-plugin-qt) and the Python computer-use engine (PyInstaller). The
# AppRun starts the engine + daemon (background) then the UI. Runs on most modern
# Linux. Computer-use still needs the host's Wayland tools (grim/spectacle, ydotool,
# wl-clipboard) — those talk to your live compositor and can't be bundled.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="${1:-0.0.0}"
BUILD="$REPO/build"
APPDIR="$BUILD/AppDir"
DIST="$REPO/dist"
TOOLS="$BUILD/appimage-tools"
ARCH="x86_64"
say(){ printf '\033[1;36m==> %s\033[0m\n' "$*" >&2; }   # stderr: never pollute $(...) capture

mkdir -p "$DIST" "$TOOLS"

# 1. Build the C++ superbuild --------------------------------------------------
say "Building jarvisd + jarvis-sidebar..."
env -u PYTHONPATH cmake -S "$REPO" -B "$BUILD" -G Ninja >/dev/null
env -u PYTHONPATH cmake --build "$BUILD"   # not silenced: build errors must surface in CI logs

# 2. AppDir skeleton -----------------------------------------------------------
say "Staging the AppDir..."
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/scalable/apps"
install -m755 "$BUILD/daemon/jarvisd"         "$APPDIR/usr/bin/jarvisd"
install -m755 "$BUILD/desktop/jarvis-sidebar" "$APPDIR/usr/bin/jarvis-sidebar"
install -m644 "$REPO/packaging/jarvis.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/jarvis.svg"
cp "$REPO/packaging/jarvis.svg" "$APPDIR/jarvis.svg"   # top-level icon AppImage wants

cat > "$APPDIR/usr/share/applications/jarvis.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Jarvis
Comment=One AI co-worker for your Linux desktop
Exec=AppRun
Icon=jarvis
Categories=Utility;Development;
Terminal=false
EOF
cp "$APPDIR/usr/share/applications/jarvis.desktop" "$APPDIR/jarvis.desktop"

# 3. Python computer-use engine (PyInstaller one-dir; optional/non-fatal) -------
say "Bundling the computer-use engine (PyInstaller)..."
if ( set -e
     ENV_VENV="$BUILD/appimg-venv"
     env -u PYTHONPATH python3 -m venv "$ENV_VENV"
     env -u PYTHONPATH "$ENV_VENV/bin/pip" install -q --upgrade pip pyinstaller
     env -u PYTHONPATH "$ENV_VENV/bin/pip" install -q -e "$REPO/computer-use"
     printf 'from computer_use_mcp.server import main\nif __name__=="__main__":\n    main()\n' \
        > "$BUILD/engine_entry.py"
     env -u PYTHONPATH "$ENV_VENV/bin/pyinstaller" --noconfirm --name jarvis-engine \
        --distpath "$APPDIR/usr/bin/engine" --workpath "$BUILD/pyi-appimg" \
        --collect-submodules computer_use_mcp "$BUILD/engine_entry.py" >/dev/null
   ); then
  say "engine bundled."
else
  echo "!! engine bundling failed — shipping the app without a bundled engine (host computer-use-mcp still works)." >&2
fi

# 4. AppRun --------------------------------------------------------------------
say "Writing AppRun..."
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
HERE="$(dirname "$(readlink -f "${0}")")"
# Qt plugin/qml paths are Qt-only (safe to export — system tools ignore them).
[ -d "$HERE/usr/plugins" ] && export QT_PLUGIN_PATH="$HERE/usr/plugins${QT_PLUGIN_PATH:+:$QT_PLUGIN_PATH}"
[ -d "$HERE/usr/qml" ] && export QML2_IMPORT_PATH="$HERE/usr/qml${QML2_IMPORT_PATH:+:$QML2_IMPORT_PATH}"
# CRITICAL: do NOT export LD_LIBRARY_PATH globally — that makes child system tools
# (pgrep/sleep/sh) load the bundled libs and segfault. Set it PER-COMMAND only, for
# the bundled Qt binaries. The PyInstaller engine is self-contained → run it clean.
unset PYTHONPATH
L="$HERE/usr/lib"
# global computer-use engine (:8794) — PyInstaller, brings its own libs.
if [ -x "$HERE/usr/bin/engine/jarvis-engine" ] && ! pgrep -f computer_use_mcp >/dev/null 2>&1; then
  "$HERE/usr/bin/engine/jarvis-engine" >/dev/null 2>&1 &
fi
# daemon (bundled Qt/libsodium via per-command LD_LIBRARY_PATH; rpath also patched).
if ! pgrep -x jarvisd >/dev/null 2>&1; then
  LD_LIBRARY_PATH="$L${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$HERE/usr/bin/jarvisd" >/dev/null 2>&1 &
  sleep 1
fi
# the UI (foreground).
exec env LD_LIBRARY_PATH="$L${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$HERE/usr/bin/jarvis-sidebar" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# 5. linuxdeploy + the Qt plugin bundle Qt/LayerShellQt/libsodium, then package --
fetch(){ # name url
  local out="$TOOLS/$1"
  if [ ! -x "$out" ]; then say "fetching $1..."; curl -fsSL "$2" -o "$out"; chmod +x "$out"; fi
  echo "$out"
}
LD="$(fetch linuxdeploy "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-${ARCH}.AppImage")"
LDQT="$(fetch linuxdeploy-plugin-qt "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/continuous/linuxdeploy-plugin-qt-${ARCH}.AppImage")"
export OUTPUT="Jarvis-${VER}-${ARCH}.AppImage"
export QML_SOURCES_PATHS="$REPO/desktop/qml"
export VERSION="$VER"
# By default linuxdeploy-plugin-qt bundles only xcb. This app runs on WAYLAND
# (Sway/KDE) + uses --selftest (offscreen), so also bundle the offscreen + wayland
# QPA plugins + wayland integration plugins. Names differ by distro (Fedora:
# libqwayland.so; Ubuntu/upstream: libqwayland-generic.so), so pick what EXISTS.
# Plugin dir + qmake from whatever Qt is active (aqt Qt 6.8 on CI under $QT_ROOT_DIR;
# distro /usr/lib*/qt6 locally) — ask qmake, don't hard-code a path.
QMAKE_BIN="$(command -v qmake6 || command -v qmake || true)"
[ -n "$QMAKE_BIN" ] && export QMAKE="$QMAKE_BIN"          # linuxdeploy-plugin-qt uses $QMAKE
QTPLUGDIR="$("${QMAKE_BIN:-qmake6}" -query QT_INSTALL_PLUGINS 2>/dev/null || ls -d /usr/lib*/qt6/plugins 2>/dev/null | head -1)"
_plats=""; for p in libqoffscreen.so libqwayland.so libqwayland-generic.so libqwayland-egl.so; do
  [ -e "$QTPLUGDIR/platforms/$p" ] && _plats="$_plats${_plats:+;}$p"; done
_qtpl=""; for d in wayland-shell-integration wayland-graphics-integration-client wayland-decoration-client; do
  [ -d "$QTPLUGDIR/$d" ] && _qtpl="$_qtpl${_qtpl:+;}$d"; done
export EXTRA_PLATFORM_PLUGINS="$_plats"
export EXTRA_QT_PLUGINS="$_qtpl"
say "bundling QPA platform plugins: $_plats"
# extract-and-run avoids needing FUSE on CI/sandboxes.
export APPIMAGE_EXTRACT_AND_RUN=1
# linuxdeploy's bundled `strip` can't parse modern .relr.dyn sections (new binutils
# on Fedora 44+), which aborts the run. Skip stripping — bigger but reliable.
export NO_STRIP=1
# linuxdeploy's bundled patchelf (0.15; also confirmed in 0.18) FATALLY corrupts the
# ELF shared libs it rewrites on Fedora 44 (glibc 2.41 / binutils 2.43). To inject the
# $ORIGIN RUNPATH when PT_DYNAMIC has no slack, it carves a new LOAD segment and moves
# .init/.plt/.dynstr/.dynamic into it — but leaves DT_INIT pointing at the OLD .init
# VirtAddr (now stale NOTE bytes), marks the new segment RW instead of RX, and doesn't
# fix RIP-relative displacements inside the moved .init code. Result: ld.so calls a
# stale/garbage DT_INIT and jarvisd SEGVs in libudev's _init before main() — the exact
# crash that failed the --selftest gate on every linux-release. Fedora system/Qt libs
# carry NO RPATH/RUNPATH of their own (they resolve via ldconfig), so the $ORIGIN
# injection buys zero portability; PATCHELF=/bin/true skips it entirely. The libs are
# still COPIED into AppDir/usr/lib intact, and AppRun's LD_LIBRARY_PATH=$HERE/usr/lib
# makes ld.so prefer the bundled copies for direct + transitive deps. (VM-verified fix.)
export PATCHELF=/bin/true
say "Running linuxdeploy (bundling Qt + LayerShellQt + deps)..."
# Bundle into the AppDir but DON'T package yet (no --output): we must prune first.
"$LD" --appdir "$APPDIR" --plugin qt \
  --executable "$APPDIR/usr/bin/jarvisd" \
  --executable "$APPDIR/usr/bin/jarvis-sidebar" \
  --desktop-file "$APPDIR/jarvis.desktop" --icon-file "$APPDIR/jarvis.svg"

# Prune host-provided libs. linuxdeploy-plugin-qt over-bundles Qt's transitive deps,
# including libs that MUST come from the host: client libs that talk to a running host
# daemon (libpipewire/libpulse/libasound — wrong version crashes on connect/disconnect)
# and ABI-sensitive system libs (glib/gio, GL/EGL/GLX, X/xcb, wayland, drm/gbm, dbus,
# systemd, ...). Bundling them clashes with the host copies and corrupts Qt at runtime
# (observed on a clean box: jarvisd SEGV in QtWebSockets::QWebSocketFrame::clear, and
# jarvis-sidebar SEGV in pw_stream_disconnect on audio teardown). This is exactly what
# the AppImage "excludelist" is for — fetch it and delete every matching lib, so they
# resolve from the host at runtime.
say "Pruning host-provided libs (AppImage excludelist)..."
EXCL="$TOOLS/excludelist"
[ -s "$EXCL" ] || curl -fsSL "https://raw.githubusercontent.com/AppImage/pkg2appimage/master/excludelist" -o "$EXCL" || true
pruned=0
if [ -s "$EXCL" ]; then
  while IFS= read -r line; do
    name="${line%%#*}"; name="$(echo "$name" | tr -d '[:space:]')"
    [ -z "$name" ] && continue
    for f in "$APPDIR"/usr/lib/"$name"*; do
      [ -e "$f" ] && { rm -f "$f"; pruned=$((pruned+1)); }
    done
  done < "$EXCL"
fi
# Belt-and-suspenders: the audio client libs are the confirmed crashers; ensure they're
# gone even if the excludelist lags a version. libudev/libsystemd are host-daemon
# interface libs that must resolve from the host anyway (version skew), and were the
# first to fault in the dl-init chain — drop them too.
for n in libpipewire-0.3 libpulse libpulsecommon libasound libudev libsystemd; do
  for f in "$APPDIR"/usr/lib/"$n"*; do [ -e "$f" ] && { rm -f "$f"; pruned=$((pruned+1)); }; done
done
say "pruned $pruned host-provided libs"

# Package the pruned AppDir with appimagetool.
say "Packaging with appimagetool..."
AT="$(fetch appimagetool "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage")"
mkdir -p "$DIST"
ARCH="$ARCH" "$AT" "$APPDIR" "$DIST/$OUTPUT"
say "done: dist/$OUTPUT"
