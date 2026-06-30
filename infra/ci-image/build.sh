#!/usr/bin/env bash
# Rebuild the prebuilt CI image and push it to the runner host's local registry.
# Run this ON the self-hosted Linux runner host (VM 104) whenever the dep list in
# Dockerfile changes. linux-ci.yml / linux-release.yml consume localhost:5000/jarvis-ci:latest.
#
# The local registry must be running (one-time):
#   docker run -d --restart=always -p 127.0.0.1:5000:5000 \
#       -v /var/lib/registry:/var/lib/registry --name registry registry:2
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="localhost:5000/jarvis-ci:latest"

echo ">>> building $IMAGE from $HERE/Dockerfile"
sudo docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
echo ">>> pushing $IMAGE to the local registry"
sudo docker push "$IMAGE"
echo ">>> done. CI runs will pull $IMAGE (instant, layer-cached)."
