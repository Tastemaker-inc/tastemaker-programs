# CI Debug Guide (Public)

Use this sequence first when debugging CI failures in `tastemaker-programs`.

## Run CI-equivalent checks

From repo root:

1. `anchor keys sync`
2. `anchor build`
3. `cargo fmt --all -- --check`
4. `cargo clippy --all-targets -- -D warnings -A unexpected_cfgs`
5. `npm run test:full`

## Debug discipline

- Reproduce one failing case first, then run the full suite.
- Inspect transaction logs before changing program logic.
- Keep `declare_id!` values and `Anchor.toml` program IDs aligned.
- Avoid changing deploy identities/authorities during routine CI debugging.

## Common classes of failures

- CPI signer/writable account mismatches
- Rent/lamport shortfalls during account initialization
- Validator startup or RPC readiness issues
- Program/account ID mismatches across config and binaries
