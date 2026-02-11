# Governance Flow

Backer-voted milestone release (quadratic voting, quorum, CPI to escrow).

## Flow

1. **Create proposal**: Artist calls `create_proposal(project_key, milestone_index, proof_uri, voting_period_secs, attempt)`. `voting_period_secs` >= 24h. `attempt` must match `ProposalAttempt.attempt` for re-proposing rejected milestones. ProposalAttempt PDA: `[b"proposal_attempt", project_key]`. Proposal PDA: `[b"proposal", project_key, milestone_index, attempt_le]`.
2. **Vote**: Backers call `cast_vote(side)`. Weight = `sqrt(backer.amount)`. One vote per (proposal, voter). Must be Active and `clock < end_ts`.
3. **Finalize**: Anyone calls `finalize_proposal` after `clock >= end_ts`. Quorum = 20% of `total_raised` (in sqrt units); pass = simple majority. If passed, CPIs `release_milestone` via `[b"release_authority"]` PDA. If rejected, artist re-proposes with next `attempt`.
4. **Cancel**: Proposal creator calls `cancel_proposal` while Active.

## Parameters

| Parameter | Value |
|-----------|--------|
| Quorum | 20% of total $TASTE in project, expressed as sqrt (same units as vote weights) |
| Threshold | Simple majority |
| Min voting period | 24 hours |
| Voting weight | sqrt(backer's $TASTE contribution) |
| Who can create | Project artist only (enforced in CreateProposal) |

## CPI

`FinalizeProposal` builds `ReleaseMilestone` and calls `project_escrow::cpi::release_milestone(cpi_ctx)` with `CpiContext::new_with_signer(..., &[seeds])` where seeds = `[b"release_authority", bump]`. Accounts passed to the CPI include `config` (project_escrow Config PDA `[b"config"]`); project_escrow validates that the signer equals `config.governance_release_authority`.
