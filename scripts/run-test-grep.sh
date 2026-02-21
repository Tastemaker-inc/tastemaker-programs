#!/usr/bin/env bash
# Run a subset of tests by Mocha --grep. Uses same validator + deploy as run-test-full.sh.
# Legacy test (needs config + taste_token first):
#   ./scripts/run-test-grep.sh "config|taste_token|claim_rwa_tokens_legacy"
# Other examples:
#   ./scripts/run-test-grep.sh "mint_receipt for first backer"
#   ./scripts/run-test-grep.sh "all backers claim RWA"
set -euo pipefail

GREP_PATTERN="${1:-}"
if [ -z "$GREP_PATTERN" ]; then
  echo "Usage: $0 <mocha-grep-pattern>" >&2
  echo "Example: $0 'claim_rwa_tokens_legacy'" >&2
  echo "Example (legacy + deps - config, taste_token, legacy): $0 'config|taste_token|claim_rwa_tokens_legacy'" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

echo "Building test bundle and running tests matching: $GREP_PATTERN"
node scripts/patch-governance-idl.cjs
mkdir -p dist/tests
npx esbuild tests/exhaustive.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/tests/exhaustive.js
npx esbuild tests/otc_market.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/tests/otc_market.js

ANCHOR_WALLET="$TEST_WALLET" ANCHOR_PROVIDER_URL="http://127.0.0.1:8899" npx mocha -t 1000000 --grep "$GREP_PATTERN" dist/tests/exhaustive.js dist/tests/otc_market.js
