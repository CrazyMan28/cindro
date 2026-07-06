#!/usr/bin/env bash
# Cross-compile the outpost-agent for every target into the outpost-mcp download
# dir. CGO_ENABLED=0 => fully static, dependency-free binaries.
set -euo pipefail
cd "$(dirname "$0")"
OUT="../outpost-mcp/agent-bin"
mkdir -p "$OUT"

build() {
  local goos="$1" goarch="$2" ext="${3:-}"
  echo "building $goos/$goarch"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags="-s -w" \
    -o "$OUT/outpost-agent-$goos-$goarch$ext" .
}

build linux   amd64
build linux   arm64
build darwin  amd64
build darwin  arm64
build windows amd64 .exe
build windows 386   .exe
echo "done -> $OUT"
ls -la "$OUT"
