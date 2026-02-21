#!/usr/bin/env bash
# Run a subset of tests by Mocha --grep. Uses same validator + deploy as run-test-full.sh.
# See tests/README.md for dependency order and safe subsets.
# Examples:
#   npm run test:config
#   npm run test:taste
#   npm run test:grep -- "config|taste_token|claim_rwa_tokens_legacy"
#   npm run test:grep -- "rwa_token|revenue_distribution"
set -euo pipefail

GREP_PATTERN="${1:-}"
if [ -z "$GREP_PATTERN" ]; then
  echo "Usage: $0 <mocha-grep-pattern>" >&2
  echo "Example: $0 'claim_rwa_tokens_legacy'" >&2
  echo "Example (with deps): $0 'config|taste_token|claim_rwa_tokens_legacy'" >&2
  echo "See tests/README.md for safe subsets." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Build output must be in ROOT_DIR/target so rwa_transfer_hook.so is found for deploy.
unset CARGO_TARGET_DIR

anchor keys sync

MPL_PROGRAM_ID="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
METADATA_SO="${ROOT_DIR}/test-programs/metadata.so"
if [ ! -f "$METADATA_SO" ]; then
  mkdir -p "${ROOT_DIR}/test-programs"
  echo "Downloading Metaplex Token Metadata program..."
  solana program dump -u m "$MPL_PROGRAM_ID" "$METADATA_SO"
fi

VALIDATOR_LOG="${ROOT_DIR}/.validator-test.log"
pkill -f "solana-test-validator" >/dev/null 2>&1 || true
pkill -f "surfpool start" >/dev/null 2>&1 || true
fuser -k 8899/tcp >/dev/null 2>&1 || true
fuser -k 8900/tcp >/dev/null 2>&1 || true

solana-test-validator --reset --ledger "${ROOT_DIR}/.test-ledger-ci" --bpf-program "$MPL_PROGRAM_ID" "$METADATA_SO" >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!

cleanup() {
  if kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "${ROOT_DIR}/.test-ledger-ci" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..30}; do
  if solana -u http://127.0.0.1:8899 block-height >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! solana -u http://127.0.0.1:8899 block-height >/dev/null 2>&1; then
  echo "Validator failed to start. See ${VALIDATOR_LOG}" >&2
  exit 1
fi

TEST_WALLET="${ROOT_DIR}/scripts/test-wallet.json"
if [ ! -f "$TEST_WALLET" ]; then
  solana-keygen new -o "$TEST_WALLET" --no-bip39-passphrase --force >/dev/null
fi

TEST_WALLET_ADDR="$(solana address -k "$TEST_WALLET")"
solana config set --keypair "$TEST_WALLET" --url http://127.0.0.1:8899 >/dev/null
solana -u http://127.0.0.1:8899 airdrop 1000 "$TEST_WALLET_ADDR" >/dev/null

echo "Building and deploying programs..."
ANCHOR_WALLET="$TEST_WALLET" anchor build -- --features test
ANCHOR_WALLET="$TEST_WALLET" anchor deploy --provider.cluster localnet --provider.wallet "$TEST_WALLET"

# Deploy rwa_transfer_hook (native program) so RWA/revenue greps work (e.g. test:grep "rwa_token").
RWA_HOOK_SO="${ROOT_DIR}/target/deploy/rwa_transfer_hook.so"
RWA_HOOK_KEYPAIR="${ROOT_DIR}/target/deploy/rwa_transfer_hook-keypair.json"
if [ ! -f "$RWA_HOOK_SO" ] || [ ! -f "$RWA_HOOK_KEYPAIR" ]; then
  cargo build-sbf -- -p rwa_transfer_hook 2>/dev/null || true
fi
export RWA_TRANSFER_HOOK_PROGRAM_ID=""
if [ -f "$RWA_HOOK_SO" ] && [ -f "$RWA_HOOK_KEYPAIR" ]; then
  if solana program deploy -u http://127.0.0.1:8899 "$RWA_HOOK_SO" --program-id "$RWA_HOOK_KEYPAIR" 2>/dev/null; then
    RWA_TRANSFER_HOOK_PROGRAM_ID="$(solana-keygen pubkey "$RWA_HOOK_KEYPAIR")"
    export RWA_TRANSFER_HOOK_PROGRAM_ID
    echo "Deployed rwa_transfer_hook: $RWA_TRANSFER_HOOK_PROGRAM_ID"
  fi
fi

echo "Building test bundle and running tests matching: $GREP_PATTERN"
node scripts/patch-governance-idl.cjs
mkdir -p dist/tests
npx esbuild tests/exhaustive.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/tests/exhaustive.js
npx esbuild tests/otc_market.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/tests/otc_market.js

ANCHOR_WALLET="$TEST_WALLET" ANCHOR_PROVIDER_URL="http://127.0.0.1:8899" \
  RWA_TRANSFER_HOOK_PROGRAM_ID="${RWA_TRANSFER_HOOK_PROGRAM_ID:-}" \
  npx mocha -t 1000000 --grep "$GREP_PATTERN" dist/tests/exhaustive.js dist/tests/otc_market.js
