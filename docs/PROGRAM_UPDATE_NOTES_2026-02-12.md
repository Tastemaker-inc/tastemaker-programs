# Program Update Notes (2026-02-12)

This note records the substantive on-chain changes included in the governance/material-edit rollout so reviewers and grant evaluators can quickly see what changed beyond CI/tooling work.

## Programs Updated

- `project_escrow`
- `governance`

## `project_escrow` Changes

- Added `ProjectTerms` account PDA (`["project_terms", project]`) to track:
  - `terms_hash`
  - `version`
  - `refund_window_end`
- Added `apply_material_edit(...)` instruction:
  - gated by `Config.governance_release_authority`
  - updates project goal/deadline/milestone percentages
  - records new terms hash and opens refund window
  - initializes `ProjectTerms` with `init_if_needed` when first used
- Added `opt_out_refund()` instruction:
  - available only while refund window is open
  - returns a backer's escrowed amount
  - prevents duplicate opt-out and enforces project/backer constraints
- Added new error paths for refund-window and opt-out safety checks.

## `governance` Changes

- Extended proposal creation to allow material-edit sentinel index (`milestone_index = 255`).
- Added `finalize_material_edit_proposal(...)` instruction:
  - enforces active proposal + voting period end + quorum
  - marks proposal `Passed`/`Rejected`
  - on pass, CPI-calls `project_escrow::apply_material_edit(...)`
- Updated CPI account constraints so release authority can safely act as writable payer for downstream account initialization.

## Test Coverage Added/Updated

- Expanded exhaustive tests with a full material-edit flow:
  - create material-edit proposal
  - cast votes
  - finalize material edit
  - validate `ProjectTerms` version/hash path
  - execute backer `opt_out_refund`
- Added harness safeguards so PDA payer rent/funding edge cases do not cause false negatives.

## CI/Operational Notes

- CI path was stabilized to use deterministic local validator startup for full suite reproducibility.
- Debugging guidance added in:
  - `docs/CI_AGENT_PLAYBOOK.md`
  - `docs/GIT_SIGNING_RULES.md`
