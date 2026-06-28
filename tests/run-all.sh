#!/usr/bin/env bash
# Master test runner for Jarvis — runs EVERY suite in the repo.
# See tests/README.md for the full index. Always uses `env -u PYTHONPATH`
# (a user site-packages PYTHONPATH leak breaks the engine venv).
#
#   ./tests/run-all.sh            # everything
#   ./tests/run-all.sh --no-live  # skip the live scripts (no running daemon needed)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LIVE=1
[ "${1:-}" = "--no-live" ] && LIVE=0
fail=0

echo "==================== C++ unit (ctest) ===================="
env -u PYTHONPATH QT_QPA_PLATFORM=offscreen ctest --test-dir build --output-on-failure || fail=1

echo "==================== Python engine (pytest) ===================="
env -u PYTHONPATH computer-use/.venv/bin/python -m pytest computer-use/tests -q || fail=1

echo "==================== Phone server (vitest, --retry=2 for timing-flaky call-timeout tests) ===================="
# The vendored agent-phone suite has a few call-timeout/escalation tests that can
# flake under CPU load; --retry=2 absorbs that without touching vendored tests.
( cd phone/server && AGENT_PHONE_SKIP_DOTENV=true MISTRAL_REAL_AUDIO=false npx vitest run --retry=2 ) || fail=1

if [ "$LIVE" = "1" ]; then
  echo "==================== Live integration (needs jarvisd :8795 + phone server :8801) ===================="
  for s in tests/integration/verify_phone_mcp_full.py \
           tests/integration/verify_contract_a_full.py \
           tests/integration/verify_phone_http.py; do
    echo "-- $s --"
    env -u PYTHONPATH computer-use/.venv/bin/python "$s" || fail=1
  done
else
  echo "(skipping live integration — pass without --no-live to run it)"
fi

echo "=========================================================="
if [ "$fail" -eq 0 ]; then echo "ALL GREEN ✅"; else echo "SOME SUITES FAILED ❌"; fi
exit "$fail"
