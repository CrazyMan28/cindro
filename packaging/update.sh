#!/usr/bin/env bash
#
# Jarvis self-update (Linux). Called by the daemon's Updater (auto, on the
# auto_update interval) and by the manual "Check for updates" button.
#
#   update.sh check   -> prints JSON {current, latest, behind} and exits 0
#   update.sh apply    -> pulls origin/main, rebuilds, restarts jarvisd, exits 0
#
# Only tracks `main` (production), respecting the dev->qa->main flow. Safe to run
# from a git checkout; for a non-git install it reports behind=false (the packaged
# build is updated by re-running the installer/bootstrap).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
MODE="${1:-check}"
BRANCH="main"

is_git() { git rev-parse --git-dir >/dev/null 2>&1; }

if ! is_git; then
  echo '{"current":null,"latest":null,"behind":false,"reason":"not a git checkout — update via the installer/bootstrap"}'
  exit 0
fi

git fetch --quiet origin "$BRANCH" || true
CURRENT="$(git rev-parse HEAD)"
LATEST="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")"
BEHIND=false
if [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ] && git merge-base --is-ancestor "$CURRENT" "origin/$BRANCH" 2>/dev/null; then
  BEHIND=true
fi

if [ "$MODE" = "check" ]; then
  printf '{"current":"%s","latest":"%s","behind":%s,"branch":"%s"}\n' \
    "${CURRENT:0:12}" "${LATEST:0:12}" "$BEHIND" "$BRANCH"
  exit 0
fi

if [ "$MODE" != "apply" ]; then echo "usage: update.sh check|apply" >&2; exit 2; fi

if [ "$BEHIND" != "true" ]; then
  echo '{"updated":false,"reason":"already up to date"}'
  exit 0
fi

echo ">> updating Jarvis to origin/$BRANCH …" >&2
# Fast-forward main (no local divergence expected on an end-user install).
git checkout --quiet "$BRANCH"
git merge --ff-only --quiet "origin/$BRANCH"
# Rebuild C++ (incremental) + refresh the engine venv if pyproject changed.
env -u PYTHONPATH cmake -S "$REPO_ROOT" -B "$REPO_ROOT/build" -G Ninja >/dev/null
env -u PYTHONPATH cmake --build "$REPO_ROOT/build" >/dev/null
( cd "$REPO_ROOT/computer-use" && env -u PYTHONPATH .venv/bin/pip install -q -e . ) || true
"$REPO_ROOT/packaging/install.sh" >/dev/null 2>&1 || true

# Restart the daemon so the new build is live (the UI reconnects automatically).
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user restart jarvisd 2>/dev/null || true
fi
NEW="$(git rev-parse --short HEAD)"
printf '{"updated":true,"to":"%s","restart":"jarvisd"}\n' "$NEW"
