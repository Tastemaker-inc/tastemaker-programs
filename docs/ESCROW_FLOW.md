# Escrow Flow

How $TASTE is held and released in project_escrow.

## Lifecycle

0. **Initialize config (one-time)**: Program upgrade authority calls `initialize_config(governance_release_authority)` with the governance program's release PDA (`[b"release_authority"]`). Creates Config PDA `[b"config"]` storing that pubkey. Only the upgrade authority can call this; validates via program account / ProgramData. For key rotation, upgrade authority calls `update_config(new_governance_release_authority)`.
1. **Create project**: Artist calls `create_project(goal, milestone_percentages[5], deadline)`. ArtistState PDA `[b"artist_state", artist]` tracks `project_count`; project PDA is `[b"project", artist, project_index_le]`. Escrow token account authority: `[b"project", project]`.
2. **Fund**: Backers call `fund_project(amount)`. 4% platform fee (2% treasury, 2% burn); 96% to escrow. Backer PDA `[b"backer", project, wallet]`; `backer.amount` and `project.total_raised` track escrowed portion.
3. **Release**: Governance CPIs `release_milestone` after a passing milestone vote. Transfers `(total_raised * milestone_pct / 100)` to artist; increments `current_milestone`; last milestone sets status to Completed. The signer must equal `Config.governance_release_authority` (validated on-chain).
4. **Cancel**: Artist calls `cancel_project`; status set to Cancelled.
5. **Refund**: After cancel, each backer calls `refund` to withdraw their share.

## Constraints

- `initialize_config` / `update_config`: only program upgrade authority (read from ProgramData).
- `fund_project`: project status Active, `clock < deadline`. Platform treasury and burn vault (PDA `[b"burn_vault"]`) receive fee; burn vault ATA receives 2% then program burns it.
- `release_milestone`: signer must equal `Config.governance_release_authority` (Config PDA `[b"config"]`); project Active; valid milestone index.
- `complete_project`: same authority check as `release_milestone`; use when all milestones already released.
- `refund`: project status Cancelled.

## Decimals

Escrow and transfers use 9 decimals (match $TASTE mint).
