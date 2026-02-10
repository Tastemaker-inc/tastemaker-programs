# Deploy to Devnet

## Prerequisites

- Anchor CLI 0.32.x
- Solana CLI, wallet with SOL on devnet: `solana config set --url devnet` and fund with `solana airdrop 2`

## Steps

1. **Program keypairs**  
   Generate if needed:
   ```bash
   solana-keygen new -o target/deploy/taste_token-keypair.json --no-bip39-passphrase
   solana-keygen new -o target/deploy/project_escrow-keypair.json --no-bip39-passphrase
   solana-keygen new -o target/deploy/governance-keypair.json --no-bip39-passphrase
   solana-keygen new -o target/deploy/rwa_token-keypair.json --no-bip39-passphrase
   ```

2. **Set program IDs**  
   Put each keypair’s pubkey into:
   - `Anchor.toml` under `[programs.devnet]`
   - The corresponding `declare_id!(...)` in each program’s `src/lib.rs`

3. **Build and deploy**
   ```bash
   anchor build
   ./scripts/deploy-devnet.sh
   ```
   Or: `anchor deploy --provider.cluster devnet`

4. **Verify program IDs**  
   ```bash
   anchor keys list
   ```
   Confirms each keypair under `target/deploy/` matches the `declare_id!` in the corresponding program.

5. **Record addresses**  
   Optionally store program IDs in `deployments/devnet.json` for frontends/scripts.

## Verified program IDs

After deployment, verify that each program’s keypair matches the ID in the binary:

```bash
anchor keys list
```

Example output (your IDs will differ):

```
taste_token:    2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo
project_escrow: bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym
governance:      AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK
rwa_token:      GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE
```

Ensure these match `[programs.devnet]` in `Anchor.toml` and each program’s `declare_id!(...)` in `src/lib.rs`. Use these IDs in Solana Explorer or for verification.
