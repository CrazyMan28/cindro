#!/usr/bin/env bash
# Jarvis — superbuild verification.
# Configures + builds the C++ superbuild and runs the full ctest suite.
# Prints a clear per-step PASS/FAIL line. Fails fast on the first error.
set -euo pipefail

ROOT="/home/kihi2024/projects/computer_use"
BUILD="${ROOT}/build"

# Print a "<STEP>: PASS/FAIL" line. Called via trap so it also fires on early exit.
LAST_STEP=""
step() { LAST_STEP="$1"; printf '>> %s\n' "$1"; }
on_exit() {
    local rc=$?
    if [ "${rc}" -ne 0 ] && [ -n "${LAST_STEP}" ]; then
        printf '%s: FAIL (exit %d)\n' "${LAST_STEP}" "${rc}"
    fi
    exit "${rc}"
}
trap on_exit EXIT

# 1) Configure
step "configure"
cmake -S "${ROOT}" -B "${BUILD}" -G Ninja
printf '%s: PASS\n' "${LAST_STEP}"

# 2) Build
step "build"
cmake --build "${BUILD}"
printf '%s: PASS\n' "${LAST_STEP}"

# 3) Test
step "ctest"
ctest --test-dir "${BUILD}" --output-on-failure
printf '%s: PASS\n' "${LAST_STEP}"

trap - EXIT
printf '\nverify.sh: ALL STEPS PASS\n'
