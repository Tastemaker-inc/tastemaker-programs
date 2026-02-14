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

## Notes

- The web marketplace requires `otc_market` to exist on the target network.
- Use explicit `--url devnet` and explicit keypair flags in deploy commands.
- If clients consume new instruction layouts (for example `rwa_token.initialize_rwa_metadata`), re-run `anchor build` and sync updated IDLs in consumer repos before release.
