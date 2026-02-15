# Deploy to Devnet (Public)

## Prerequisites

- Anchor CLI 0.32.x
- Solana CLI
- Devnet keypair with deploy/upgrade authority for your programs

## Deploy flow

1. Verify key + balance:
   - `solana-keygen pubkey <DEPLOY_KEYPAIR>`
   - `solana balance --url devnet --keypair <DEPLOY_KEYPAIR>`
2. Build:
   - `anchor build --ignore-keys`
3. Deploy/upgrade programs on devnet:
   - `solana program deploy target/deploy/project_escrow.so --program-id <PROJECT_ESCROW_ID> --upgrade-authority <DEPLOY_KEYPAIR> --keypair <DEPLOY_KEYPAIR> --url devnet`
   - `solana program deploy target/deploy/governance.so --program-id <GOVERNANCE_ID> --upgrade-authority <DEPLOY_KEYPAIR> --keypair <DEPLOY_KEYPAIR> --url devnet`
   - `solana program deploy target/deploy/otc_market.so --program-id <OTC_MARKET_ID> --upgrade-authority <DEPLOY_KEYPAIR> --keypair <DEPLOY_KEYPAIR> --url devnet`
   - `solana program deploy target/deploy/rwa_token.so --program-id <RWA_TOKEN_ID> --upgrade-authority <DEPLOY_KEYPAIR> --keypair <DEPLOY_KEYPAIR> --url devnet`
4. Verify:
   - `solana program show <PROJECT_ESCROW_ID> --url devnet`
   - `solana program show <GOVERNANCE_ID> --url devnet`
   - `solana program show <OTC_MARKET_ID> --url devnet`
   - `solana program show <RWA_TOKEN_ID> --url devnet`
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
- If clients consume new instruction layouts (for example `rwa_token.initialize_rwa_metadata`), re-run `anchor build` and sync updated IDLs in consumer repos before release.
