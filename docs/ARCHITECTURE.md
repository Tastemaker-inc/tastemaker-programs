# Architecture

On-chain programs for [TasteMaker](https://tastemaker.music): platform token, project escrow, governance (milestone release), and per-project RWA tokens.

## Programs

| Program | Purpose |
|---------|---------|
| **taste_token** | $TASTE platform mint (9 decimals). Initialize mint + treasury, mint to treasury or recipient, burn. |
| **project_escrow** | Artist creates project; backers fund with $TASTE; escrow holds funds; governance CPI releases by milestone. |
| **governance** | Proposals for milestone release; quadratic voting (sqrt of backer amount); quorum 20%; finalize CPI to `release_milestone`. |
| **rwa_token** | Per-project RWA mint; backers claim (pull) by share after project completed; close distribution to freeze mint. |

## Dependencies

- **taste_token**: standalone (spl-token / Token-2022).
- **project_escrow**: reads/writes Project, Backer, Escrow; accepts CPI from governance for `release_milestone`.
- **governance**: reads project_escrow Project and Backer; CPIs project_escrow `release_milestone` with release PDA signer and project_escrow Config account.
- **rwa_token**: standalone; keyed by project pubkey (project_escrow Project account).

## PDAs (seeds)

- **taste_token:** `[b"taste_mint"]`, `[b"treasury"]` (treasury authority).
- **project_escrow:** `[b"config"]` (Config: `governance_release_authority`), `[b"artist_state", artist]`, `[b"project", artist, project_index_le]`, `[b"escrow", project]`, `[b"backer", project, wallet]`, `[b"project", project]` (escrow authority), `[b"burn_vault"]` (fee burn).
- **governance:** `[b"proposal_attempt", project]`, `[b"proposal", project_key, milestone_index, attempt_le]`, `[b"vote", proposal, voter]`, `[b"release_authority"]`.
- **rwa_token:** `[b"rwa_state", project]`, `[b"rwa_mint", project]`, `[b"rwa_mint_authority", project]`, `[b"claim", project, backer]`.

## Build & test

```bash
anchor build
anchor test
```

## Deploy (devnet)

See [DEPLOY_DEVNET.md](./DEPLOY_DEVNET.md) or `scripts/deploy-devnet.sh`.

## Security

- **Config**: One-time `initialize_config` (and optional `update_config` for key rotation) restricted to the project_escrow program **upgrade authority** (read from ProgramData). Config PDA `[b"config"]` stores `governance_release_authority`.
- Escrow release: `release_milestone` and `complete_project` require the signer to equal `Config.governance_release_authority` (the governance program's release PDA, not an admin key). No circular dependency on governance program; supports key rotation via `update_config`.
- No admin backdoors; mint authority for $TASTE is set at init (move to multisig for mainnet).
