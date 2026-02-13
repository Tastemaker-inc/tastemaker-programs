# CI Agent Playbook (Read Before Debugging)

This repository's CI failures are often caused by **test harness assumptions**, not program logic regressions.

Use this checklist first to avoid repeating the same mistakes.

## 1) Run the exact CI-equivalent commands

From `tastemaker-programs/`, run in this order:

```bash
anchor keys sync
anchor build
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings -A unexpected_cfgs
npm run test:full
```

`npm run test:full` is wrapped by `scripts/run-test-full.sh`, which:

- starts a clean `solana-test-validator` on a dedicated ledger
- waits for RPC readiness
- ensures the local test wallet exists and is funded
- runs `anchor test --skip-local-validator ...`

Do not bypass this wrapper unless you are intentionally debugging validator behavior.

## 2) Preserve signing and deploy authority assumptions

- **Never rotate upgrade authority** during CI debugging.
- **Never treat test wallet generation as deploy authority changes.**
- Keep `declare_id!` values and `Anchor.toml` program IDs aligned.
- **New programs**: Before `anchor keys sync`, ensure `target/deploy/<program>-keypair.json` exists (e.g. generate once with `solana-keygen new -o target/deploy/otc_market-keypair.json --no-bip39-passphrase --force`). CI cache may restore `target/` so keypairs persist across runs.

If you see upgrade-authority mismatch errors in local tests, it is almost always stale validator state or wrong wallet context, not a reason to change deployed identities.

## 3) Known noisy warnings vs real blockers

Expected noise:

- `unexpected cfg condition value: anchor-debug`

These warnings are currently tolerated by CI (`-A unexpected_cfgs` in Clippy). Do not chase them as root cause unless behavior changed.

Real blockers to focus on:

- CPI unauthorized signer/writable account
- insufficient lamports/rent during account initialization
- upgrade authority mismatch
- validator startup/rpc readiness failures

## 4) Recent hard-to-find failure patterns

### A) CPI writable escalation in governance material edit finalize

Symptom:

- `Cross-program invocation with unauthorized signer or writable account`
- writable privilege escalated for release authority

Fix:

- `FinalizeMaterialEditProposal.release_authority` must be `#[account(mut, ...)]` in `programs/governance/src/lib.rs`.

### B) Rent/lamports failure when material edit initializes `ProjectTerms`

Symptom:

- `insufficient funds for rent` or system transfer insufficient lamports
- failure occurs inside `ApplyMaterialEdit` CPI

Root cause:

- `project_escrow::ApplyMaterialEdit` uses `init_if_needed` with `payer = governance_authority`.
- `governance_authority` is the `release_authority` PDA, which must hold lamports in test context.

Fix in tests:

- airdrop lamports to `release_authority` PDA before calling `finalizeMaterialEditProposal`.

## 5) Debug discipline to keep turnaround fast

- Re-run only one failing case first, then full suite.
- Always inspect transaction logs before changing program code.
- Avoid introducing alternate validator stacks mid-debug; use the CI path.
- If changing test harness behavior, document the reason in this file.

## 6) Pre-commit guardrail

Before committing:

1. `npm run test:full` passes.
2. Build + fmt + clippy checks pass.
3. No temporary artifacts (`.validator-test.log`, temp ledgers, scratch files) are staged.
4. No changes to deploy identities/authorities unless explicitly requested.

## 7) Deploy key usage (for upgrade tasks)

- Do not scan the filesystem for "possible keypairs".
- Use the documented devnet upgrade authority directly:
  - `~/.config/solana/devnet-deploy.json`
  - pubkey `F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`
- Never use `scripts/test-wallet.json` for devnet deploy/upgrade.
- Always pass explicit flags in deploy commands:
  - `--url devnet`
  - `--keypair ~/.config/solana/devnet-deploy.json`
  - `--upgrade-authority ~/.config/solana/devnet-deploy.json`
- Programs to deploy/upgrade on devnet: **project_escrow**, **governance**, **otc_market**. Full steps (including OTC market) are in `docs/DEPLOY_DEVNET.md`. The web marketplace requires `otc_market` to be deployed for create/accept offers to work.
