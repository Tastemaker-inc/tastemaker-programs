#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Cursor/sandbox sets CARGO_TARGET_DIR to a temp path; build output must be in ROOT_DIR/target
# so rwa_transfer_hook.so is found for deploy. Otherwise "Unsupported program id" (hook not deployed).
unset CARGO_TARGET_DIR

# Full workspace clean so all programs and IDLs are rebuilt with consistent declare_id.
# Stale incremental build can cause InvalidProgramId (governance expects wrong rwa_token address).
cargo clean 2>/dev/null || true

# First build: create keypairs (cargo clean removed them). Some Anchor CLI versions support
# --ignore-keys; others (e.g. older CI images) do not. If --ignore-keys fails, generate
# keypairs manually so a single anchor build works.
if ! anchor build --ignore-keys -- --features test 2>/dev/null; then
  echo "anchor build --ignore-keys not supported; generating keypairs then building..."
  mkdir -p "${ROOT_DIR}/target/deploy"
  for program in governance otc_market project_escrow revenue_distribution rwa_token taste_token; do
    kp="${ROOT_DIR}/target/deploy/${program}-keypair.json"
    if [ ! -f "$kp" ]; then
      solana-keygen new -o "$kp" --no-bip39-passphrase --force >/dev/null 2>&1
    fi
  done
  anchor keys sync
fi
# Sync keypairs to Anchor.toml so second build and deploy use consistent declare_id (when --ignore-keys was used).
anchor keys sync 2>/dev/null || true
anchor build -- --features test

# Build rwa_transfer_hook (native Solana program, not Anchor; no IDL). Required for RWA mint creation.
# Done after anchor build so cargo-build-sbf post_processing sees a complete workspace.
cargo build-sbf -- -p rwa_transfer_hook

# Metaplex Token Metadata program for receipt/RWA metadata tests (CI downloads if missing).
MPL_PROGRAM_ID="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
METADATA_SO="${ROOT_DIR}/test-programs/metadata.so"
if [ ! -f "$METADATA_SO" ]; then
  mkdir -p "${ROOT_DIR}/test-programs"
  echo "Downloading Metaplex Token Metadata program for local validator..."
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

# Create test wallet and set as default signer before any solana CLI deploy (CI has no ~/.config/solana/id.json).
TEST_WALLET="${ROOT_DIR}/scripts/test-wallet.json"
if [ ! -f "$TEST_WALLET" ]; then
  solana-keygen new -o "$TEST_WALLET" --no-bip39-passphrase --force >/dev/null
fi
TEST_WALLET_ADDR="$(solana address -k "$TEST_WALLET")"
solana config set --keypair "$TEST_WALLET" --url http://127.0.0.1:8899 >/dev/null
solana -u http://127.0.0.1:8899 airdrop 1000 "$TEST_WALLET_ADDR" >/dev/null

# Deploy rwa_transfer_hook (native program, not built by anchor build). Required for RWA mint CPI.
# Without this, finalizeProposal -> InitializeRwaMintByGovernance fails with "Unsupported program id".
# Deploy uses default signer (test wallet above) so CI and local work without ~/.config/solana/id.json.
RWA_HOOK_SO="${ROOT_DIR}/target/deploy/rwa_transfer_hook.so"
RWA_HOOK_KEYPAIR="${ROOT_DIR}/target/deploy/rwa_transfer_hook-keypair.json"
if [ ! -f "$RWA_HOOK_SO" ] || [ ! -f "$RWA_HOOK_KEYPAIR" ]; then
  echo "Missing rwa_transfer_hook build artifacts. Expected: $RWA_HOOK_SO and $RWA_HOOK_KEYPAIR" >&2
  echo "Ensure CARGO_TARGET_DIR is unset and 'cargo build-sbf -p rwa_transfer_hook' ran." >&2
  exit 1
fi
if ! solana program deploy -u http://127.0.0.1:8899 "$RWA_HOOK_SO" --program-id "$RWA_HOOK_KEYPAIR"; then
  echo "rwa_transfer_hook deploy failed. Check validator and keypair (default signer: $TEST_WALLET)." >&2
  exit 1
fi
RWA_TRANSFER_HOOK_PROGRAM_ID="$(solana-keygen pubkey "$RWA_HOOK_KEYPAIR")"
export RWA_TRANSFER_HOOK_PROGRAM_ID

# Optional: set TEST_GREP to run only matching tests (e.g. TEST_GREP="initializes RwaConfig"). run-mocha.sh reads it.
ANCHOR_WALLET="$TEST_WALLET" TEST_GREP="${TEST_GREP:-}" \
anchor test --skip-local-validator --provider.cluster localnet --provider.wallet "$TEST_WALLET" -- --features test
