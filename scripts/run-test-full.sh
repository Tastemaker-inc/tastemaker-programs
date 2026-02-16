#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Align program IDs with deploy keypairs (same as CI) so built IDL matches deployed programs.
anchor keys sync

VALIDATOR_LOG="${ROOT_DIR}/.validator-test.log"
pkill -f "solana-test-validator" >/dev/null 2>&1 || true
pkill -f "surfpool start" >/dev/null 2>&1 || true
fuser -k 8899/tcp >/dev/null 2>&1 || true
fuser -k 8900/tcp >/dev/null 2>&1 || true

solana-test-validator --reset --ledger "${ROOT_DIR}/.test-ledger-ci" >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!

cleanup() {
  if kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "${ROOT_DIR}/.test-ledger-ci" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for RPC readiness before deploying test programs.
for _ in {1..30}; do
  if solana -u http://127.0.0.1:8899 block-height >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! solana -u http://127.0.0.1:8899 block-height >/dev/null 2>&1; then
  echo "Local validator failed to start. See ${VALIDATOR_LOG}" >&2
  exit 1
fi

TEST_WALLET="${ROOT_DIR}/scripts/test-wallet.json"
if [ ! -f "$TEST_WALLET" ]; then
  solana-keygen new -o "$TEST_WALLET" --no-bip39-passphrase --force >/dev/null
fi

TEST_WALLET_ADDR="$(solana address -k "$TEST_WALLET")"
solana config set --keypair "$TEST_WALLET" --url http://127.0.0.1:8899 >/dev/null
solana -u http://127.0.0.1:8899 airdrop 1000 "$TEST_WALLET_ADDR" >/dev/null

ANCHOR_WALLET="$TEST_WALLET" \
anchor test --skip-local-validator --provider.cluster localnet --provider.wallet "$TEST_WALLET" -- --features test
