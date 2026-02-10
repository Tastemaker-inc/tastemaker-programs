# Escrow Flow

How $TASTE is held and released in project_escrow.

## Lifecycle

1. **Create project**: Artist calls `create_project(goal, milestone_percentages[5], deadline)`. ArtistState PDA `[b"artist_state", artist]` tracks `project_count`; project PDA is `[b"project", artist, project_index_le]`. Escrow token account authority: `[b"project", project]`.
2. **Fund**: Backers call `fund_project(amount)`. 4% platform fee (2% treasury, 2% burn); 96% to escrow. Backer PDA `[b"backer", project, wallet]`; `backer.amount` and `project.total_raised` track escrowed portion.
3. **Release**: Governance CPIs `release_milestone` after a passing milestone vote. Transfers `(total_raised * milestone_pct / 100)` to artist; increments `current_milestone`; last milestone sets status to Completed.
4. **Cancel**: Artist calls `cancel_project`; status set to Cancelled.
5. **Refund**: After cancel, each backer calls `refund` to withdraw their share.

## Constraints

- `fund_project`: project status Active, `clock < deadline`. Platform treasury and burn vault (PDA `[b"burn_vault"]`) receive fee; burn vault ATA receives 2% then program burns it.
- `release_milestone`: caller must be governance release PDA (CPI signer); project Active; valid milestone index.
- `refund`: project status Cancelled.

## Decimals

Escrow and transfers use 9 decimals (match $TASTE mint).
