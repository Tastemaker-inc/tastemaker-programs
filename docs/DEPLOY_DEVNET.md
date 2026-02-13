# Deploy to Devnet

## Prerequisites

- Anchor CLI 0.32.x
- Solana CLI
- Devnet upgrade authority keypair at:
  - `~/.config/solana/devnet-deploy.json`
  - expected pubkey: `F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`
- Never assume Solana CLI default config is correct; always pass explicit `--url devnet` and keypair flags.

## Steps

1. **Verify upgrade authority and balance**
   ```bash
   solana-keygen pubkey ~/.config/solana/devnet-deploy.json
   solana balance --url devnet --keypair ~/.config/solana/devnet-deploy.json
   ```

2. **Verify deployed program authorities (before upgrade)**
   ```bash
   solana program show bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym --url devnet
   solana program show AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK --url devnet
   ```
   Confirm `Authority` is `F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`.

3. **Temporarily align on-chain program IDs for upgrade build**
   - This repository keeps local test IDs in `declare_id!` for deterministic CI.
   - For devnet upgrade binaries, temporarily set:
     - `project_escrow/src/lib.rs` to `bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym`
     - `governance/src/lib.rs` to `AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK`

4. **Build upgrade binaries**
   ```bash
   anchor build --ignore-keys
   ```
   `--ignore-keys` is required because local test keypairs differ from devnet program IDs.

5. **Upgrade programs on devnet (explicit signer + authority)**
   ```bash
   solana program deploy target/deploy/project_escrow.so \
     --program-id bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym \
     --upgrade-authority ~/.config/solana/devnet-deploy.json \
     --keypair ~/.config/solana/devnet-deploy.json \
     --url devnet

   solana program deploy target/deploy/governance.so \
     --program-id AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK \
     --upgrade-authority ~/.config/solana/devnet-deploy.json \
     --keypair ~/.config/solana/devnet-deploy.json \
     --url devnet
   ```

6. **Verify upgrades**
   ```bash
   solana program show bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym --url devnet
   solana program show AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK --url devnet
   ```
   Confirm `Last Deployed In Slot` changed and authority is unchanged.

7. **Revert `declare_id!` files back to local CI/test IDs**
   - `project_escrow/src/lib.rs`: `2YH9c5BMDLNqQ7V9t3UF2x32xN8d8BukhhrJCduPQJip`
   - `governance/src/lib.rs`: `8NhAWmnGX1dk5AUnt99MMUeZ5rjjtiRGHjrq5eeqsRAC`
   - Run CI/local tests again (`npm run test:full`) before committing.

8. **Initialize $TASTE mint (once per deployment/environment)**  
   The project_escrow and web app require the $TASTE mint to exist. From `tastemaker-programs` run:
   ```bash
   npm run init-taste-mint
   ```
   Uses your default Solana keypair (`~/.config/solana/id.json`) or `SOLANA_KEYPAIR`; ensure it has SOL on devnet. Idempotent: skips if mint already exists.

9. **Initialize project_escrow config (once per deployment)**  
   The upgrade authority of the project_escrow program must call `initialize_config(governance_release_authority)` with the governance program's release PDA (e.g. `PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0]`). Pass the program account (project_escrow program id), the program's ProgramData account (PDA from BPF Loader Upgradeable), and the upgrade authority as signer. This records the only key that can call `release_milestone` / `complete_project`. For key rotation, call `update_config(new_authority)` with the same authority check.

10. **Verify local test IDs for CI**  
   ```bash
   anchor keys list
   ```
   Confirms each keypair under `target/deploy/` matches the `declare_id!` in the corresponding program.

11. **Record addresses**  
   Optionally store program IDs in `deployments/devnet.json` for frontends/scripts.

## Verified program IDs

After deployment, verify that each program's keypair matches the ID in the binary:

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

Ensure these match `[programs.devnet]` in `Anchor.toml` and each program's `declare_id!(...)` in `src/lib.rs`. Use these IDs in Solana Explorer or for verification.
