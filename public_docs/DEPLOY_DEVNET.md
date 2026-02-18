# Deploy to Devnet (Public)

**For upgrades of existing devnet programs:** Use the flow in the monorepo rule **`.cursor/rules/devnet-deploy-upgrade.mdc`**: build with `cargo build-sbf --features devnet` per program (NOT `anchor build`), then `solana program deploy target/deploy/<program>.so --program-id <DEVNET_PROGRAM_ID> --upgrade-authority ~/.config/solana/devnet-deploy.json --keypair ~/.config/solana/devnet-deploy.json --url devnet`. Do not use `anchor deploy -p` for upgrades (it uses keypair-derived program IDs, not the live devnet IDs).

## Prerequisites

- Anchor CLI 0.32.x
- Solana CLI
- Devnet keypair: **`~/.config/solana/devnet-deploy.json`** (pubkey `F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`). This is the upgrade authority for all devnet programs.

## Funding the upgrade authority

Deployment and upgrades require SOL on the **upgrade authority** keypair (see `Anchor.toml` `[programs.devnet]` and the keypair used with `--upgrade-authority`). If the balance is 0, `anchor deploy` or `solana program deploy` will fail with "Attempt to debit an account but found no record of a prior credit."

**Current devnet upgrade authority (fund this for testnet SOL):**

```
F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU
```

- Check balance: `solana balance --url devnet F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`
- Airdrop (devnet): `solana airdrop 5 F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU --url devnet` (may be rate-limited; use a devnet faucet or wait and retry).
- Then run the deploy flow below. Use the keypair whose pubkey is this address (e.g. `~/.config/solana/devnet-deploy.json` if that matches; otherwise the keypair you used for the initial deploy).

## Deploy flow

Use **`~/.config/solana/devnet-deploy.json`** as `<DEPLOY_KEYPAIR>` (pubkey `F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`).

1. Verify key + balance:
   - `solana-keygen pubkey ~/.config/solana/devnet-deploy.json`
   - `solana balance --url devnet --keypair ~/.config/solana/devnet-deploy.json`
2. Build for devnet (so binaries have devnet `declare_id!`):
   **Use `cargo build-sbf` directly — NOT `anchor build`.** Anchor silently drops `--features` passed after `--`, producing binaries with the wrong (localnet) `declare_id!` that cause `DeclaredProgramIdMismatch` (error 4100) at runtime.
   ```bash
   cd tastemaker-programs
   cargo build-sbf --manifest-path programs/project_escrow/Cargo.toml --features devnet --sbf-out-dir target/deploy
   cargo build-sbf --manifest-path programs/rwa_token/Cargo.toml --features devnet --sbf-out-dir target/deploy
   cargo build-sbf --manifest-path programs/governance/Cargo.toml --features devnet --sbf-out-dir target/deploy
   cargo build-sbf --manifest-path programs/taste_token/Cargo.toml --features devnet --sbf-out-dir target/deploy
   ```
3. Deploy/upgrade programs on devnet (use these exact devnet program IDs from `Anchor.toml [programs.devnet]`):
   - `solana program deploy target/deploy/project_escrow.so --program-id bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym --upgrade-authority ~/.config/solana/devnet-deploy.json --keypair ~/.config/solana/devnet-deploy.json --url devnet`
   - `solana program deploy target/deploy/governance.so --program-id AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK --upgrade-authority ~/.config/solana/devnet-deploy.json --keypair ~/.config/solana/devnet-deploy.json --url devnet`
   - `solana program deploy target/deploy/otc_market.so --program-id 6FM7VKFLyzxubAhCY58rR1R42tuuVNY7QdAtNTq65EjN --upgrade-authority ~/.config/solana/devnet-deploy.json --keypair ~/.config/solana/devnet-deploy.json --url devnet`
   - `solana program deploy target/deploy/rwa_token.so --program-id GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE --upgrade-authority ~/.config/solana/devnet-deploy.json --keypair ~/.config/solana/devnet-deploy.json --url devnet`
   - `solana program deploy target/deploy/taste_token.so --program-id 2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo --upgrade-authority ~/.config/solana/devnet-deploy.json --keypair ~/.config/solana/devnet-deploy.json --url devnet`
4. Verify (confirm `Last Deployed In Slot` and `Authority` = F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU):
   - `solana program show 2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo --url devnet`
   - `solana program show bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym --url devnet`
   - `solana program show AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK --url devnet`
   - `solana program show GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE --url devnet`
   - `solana program show 6FM7VKFLyzxubAhCY58rR1R42tuuVNY7QdAtNTq65EjN --url devnet`
5. Confirm IDs in:
   - `Anchor.toml`
   - program `declare_id!`
   - frontend constants/IDLs

## One-time init (devnet)

After deploying, run these once so devnet can use short voting periods and early finalize:

1. **Governance config** (enables early finalize + short min voting period):
   - From `tastemaker-programs/`:  
     `SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npm run init-governance-config`
   - Optional env: `MIN_VOTING_PERIOD_SECS=60` (default 60); `GOVERNANCE_PROGRAM_ID` to override program id.

2. **Vote-weight backfill** (for existing projects that already have backers; new projects get vote weight on first fund):
   - For each project PDA that existed before vote-weight was added:  
     `npm run backfill-vote-weight-pdas -- <PROJECT_PDA>`
   - Same env as above; optional `PROJECT_ESCROW_PROGRAM_ID` to override.
   - Without this, early finalize will not be available for those projects (finalize still works after `end_ts`).

## Notes

- The web marketplace requires `otc_market` to exist on the target network.
- Use explicit `--url devnet` and explicit keypair flags in deploy commands.
- If clients consume new instruction layouts (for example `rwa_token.initialize_rwa_metadata`), rebuild and sync updated IDLs in consumer repos (e.g. `web/lib/idl/`) before release.
- **Never use `anchor build -- --features devnet` for devnet builds.** Anchor silently ignores the `--features` flag, producing binaries with localnet `declare_id!` values. Always use `cargo build-sbf --features devnet` directly.
- **After program changes** (e.g. RWA freeze authority removal, funding cap `GoalExceeded`): deploy to devnet so the web app and tests use the latest behavior. Until the upgrade is applied, existing devnet programs keep the old logic.
