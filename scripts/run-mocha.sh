#!/usr/bin/env bash
# Runs patch, esbuild, and mocha. Optional: set TEST_GREP to run only matching tests (e.g. TEST_GREP="initializes RwaConfig").
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
node scripts/patch-governance-idl.cjs
mkdir -p dist/tests
npx esbuild tests/exhaustive.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/tests/exhaustive.js
npx esbuild tests/otc_market.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/tests/otc_market.js
exec npx mocha -t 1000000 dist/tests/exhaustive.js dist/tests/otc_market.js ${TEST_GREP:+--grep "$TEST_GREP"}
