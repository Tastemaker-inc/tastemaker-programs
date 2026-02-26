#!/usr/bin/env bash
# Fix ~/.cache/solana ownership so cargo-build-sbf can run without permission errors.
# Run once: sudo scripts/fix-solana-cache-permissions.sh
set -e
CACHE="${HOME:-/home/$(whoami)}/.cache/solana"
if [[ -d "$CACHE" ]]; then
  chown -R "$(logname):$(logname)" "$CACHE"
  echo "Fixed ownership of $CACHE"
else
  echo "No directory at $CACHE"
fi
