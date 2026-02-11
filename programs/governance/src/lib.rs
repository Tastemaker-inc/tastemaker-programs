//! TasteMaker governance: proposals and quadratic voting for milestone release.
//! Adapted from HYPNOSecosystem Governance.sol.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK");

pub const QUORUM_BPS: u16 = 2000; // 20%
/// Min voting period: 24h in prod; 1s when built with `--features governance/test` for tests.
#[cfg(feature = "test")]
pub const MIN_VOTING_PERIOD_SECS: i64 = 1;
#[cfg(not(feature = "test"))]
pub const MIN_VOTING_PERIOD_SECS: i64 = 24 * 3600;
pub const MAX_PROOF_URI_LEN: usize = 200;

/// Babylonian method (from HYPNOSecosystem Governance.sol).
#[inline]
pub(crate) fn sqrt_u64(x: u64) -> u64 {
    if x == 0 {
        return 0;
    }
    let mut z = x.div_ceil(2);
    let mut y = x;
    while z < y {
        y = z;
        z = (x / z + z) / 2;
    }
    y
}

#[program]
pub mod governance {
    use super::*;

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        project_key: Pubkey,
        milestone_index: u8,
        proof_uri: String,
        voting_period_secs: i64,
        attempt: u64,
    ) -> Result<()> {
        require!(
            voting_period_secs >= MIN_VOTING_PERIOD_SECS,
            GovError::VotingPeriodTooShort
        );
        require!(milestone_index < 5, GovError::InvalidMilestoneIndex);

        let attempt_acc = &mut ctx.accounts.proposal_attempt;
        require!(
            attempt_acc.attempt == attempt,
            GovError::InvalidProposalAttempt
        );
        attempt_acc.attempt = attempt_acc
            .attempt
            .checked_add(1)
            .ok_or(GovError::Overflow)?;

        let clock = Clock::get()?;
        let start_ts = clock.unix_timestamp;
        let end_ts = start_ts
            .checked_add(voting_period_secs)
            .ok_or(GovError::Overflow)?;

        let p = &mut ctx.accounts.proposal;
        p.project = project_key;
        p.milestone_index = milestone_index;
        p.proof_uri = proof_uri;
        p.votes_for = 0;
        p.votes_against = 0;
        p.status = ProposalStatus::Active;
        p.start_ts = start_ts;
        p.end_ts = end_ts;
        p.creator = ctx.accounts.artist.key();
        Ok(())
    }

    pub fn cast_vote(ctx: Context<CastVote>, side: bool) -> Result<()> {
        let proposal = &ctx.accounts.proposal;
        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < proposal.end_ts,
            GovError::VotingEnded
        );

        let backer = &ctx.accounts.backer;
        require!(backer.amount > 0, GovError::NoContribution);
        let weight = sqrt_u64(backer.amount);

        let vote = &mut ctx.accounts.vote;
        vote.proposal = proposal.key();
        vote.voter = ctx.accounts.voter.key();
        vote.weight = weight;
        vote.side = side;

        let proposal_acc = &mut ctx.accounts.proposal;
        if side {
            proposal_acc.votes_for = proposal_acc
                .votes_for
                .checked_add(weight)
                .ok_or(GovError::Overflow)?;
        } else {
            proposal_acc.votes_against = proposal_acc
                .votes_against
                .checked_add(weight)
                .ok_or(GovError::Overflow)?;
        }
        Ok(())
    }

    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= proposal.end_ts,
            GovError::VotingNotEnded
        );

        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .ok_or(GovError::Overflow)?;
        let project = &ctx.accounts.project;
        let total_escrowed = project.total_raised;
        // sqrt(QUORUM_BPS% of total_raised) in same units as vote weights
        let quorum_raw = (total_escrowed as u128 * QUORUM_BPS as u128 / 10_000) as u64;
        let quorum_votes = sqrt_u64(quorum_raw);
        require!(total_votes >= quorum_votes, GovError::QuorumNotMet);

        let passed = proposal.votes_for > proposal.votes_against;
        proposal.status = if passed {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Rejected
        };

        if passed {
            let bump_seed = ctx.bumps.release_authority;
            let seeds: &[&[u8]] = &[b"release_authority", &[bump_seed]];
            let signer_seeds = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.project_escrow_program.to_account_info(),
                project_escrow::cpi::accounts::ReleaseMilestone {
                    governance_authority: ctx.accounts.release_authority.to_account_info(),
                    config: ctx.accounts.escrow_config.to_account_info(),
                    project: ctx.accounts.project.to_account_info(),
                    escrow: ctx.accounts.escrow.to_account_info(),
                    escrow_authority: ctx.accounts.escrow_authority.to_account_info(),
                    artist_token_account: ctx.accounts.artist_token_account.to_account_info(),
                    taste_mint: ctx.accounts.taste_mint.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer_seeds,
            );
            project_escrow::cpi::release_milestone(cpi_ctx)?;
        }
        Ok(())
    }

    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        require!(
            ctx.accounts.creator.key() == proposal.creator,
            GovError::NotProposalCreator
        );
        proposal.status = ProposalStatus::Cancelled;
        Ok(())
    }
}

#[error_code]
pub enum GovError {
    #[msg("Voting period must be at least 24 hours")]
    VotingPeriodTooShort,
    #[msg("Invalid milestone index")]
    InvalidMilestoneIndex,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Proposal is not active")]
    ProposalNotActive,
    #[msg("Voting has ended")]
    VotingEnded,
    #[msg("No contribution in this project")]
    NoContribution,
    #[msg("Voting period has not ended")]
    VotingNotEnded,
    #[msg("Quorum not met")]
    QuorumNotMet,
    #[msg("Only proposal creator can cancel")]
    NotProposalCreator,
    #[msg("Only project artist can create proposals")]
    NotArtist,
    #[msg("Invalid proposal attempt")]
    InvalidProposalAttempt,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Cancelled,
}

#[account]
pub struct Proposal {
    pub project: Pubkey,
    pub milestone_index: u8,
    pub proof_uri: String,
    pub votes_for: u64,
    pub votes_against: u64,
    pub status: ProposalStatus,
    pub start_ts: i64,
    pub end_ts: i64,
    pub creator: Pubkey,
}

#[account]
pub struct Vote {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub weight: u64,
    pub side: bool,
}

#[account]
pub struct ProposalAttempt {
    pub attempt: u64,
}

#[derive(Accounts)]
#[instruction(project_key: Pubkey, milestone_index: u8, _proof_uri: String, _voting_period_secs: i64, attempt: u64)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub artist: Signer<'info>,

    #[account(
        init_if_needed,
        payer = artist,
        space = 8 + 8,
        seeds = [b"proposal_attempt", project_key.as_ref()],
        bump,
    )]
    pub proposal_attempt: Account<'info, ProposalAttempt>,

    #[account(
        init,
        payer = artist,
        space = 8 + 32 + 1 + 4 + MAX_PROOF_URI_LEN + 8 + 8 + 1 + 8 + 8 + 32,
        seeds = [b"proposal", project_key.as_ref(), &[milestone_index], &attempt.to_le_bytes()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        constraint = project.key() == project_key,
        constraint = project.artist == artist.key() @ GovError::NotArtist,
    )]
    pub project: Account<'info, project_escrow::Project>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: bool)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,

    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    #[account(
        constraint = backer.project == proposal.project,
        constraint = backer.wallet == voter.key(),
    )]
    pub backer: Account<'info, project_escrow::Backer>,

    #[account(
        init,
        payer = voter,
        space = 8 + 32 + 32 + 8 + 1,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()],
        bump,
    )]
    pub vote: Account<'info, Vote>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeProposal<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    #[account(mut)]
    pub project: Account<'info, project_escrow::Project>,

    /// PDA that signs for governance CPI to project_escrow
    /// CHECK: validated by seeds
    #[account(seeds = [b"release_authority"], bump)]
    pub release_authority: UncheckedAccount<'info>,

    /// Project escrow config PDA (seeds = [b"config"]). Must match project_escrow program's config PDA.
    #[account(
        constraint = escrow_config.key() == Pubkey::find_program_address(&[b"config"], &project_escrow_program.key()).0
    )]
    pub escrow_config: Account<'info, project_escrow::Config>,

    #[account(mut)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: escrow authority PDA from project_escrow (validated by CPI target)
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub artist_token_account: InterfaceAccount<'info, TokenAccount>,

    pub taste_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,

    pub project_escrow_program: Program<'info, project_escrow::program::ProjectEscrow>,
}

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    pub creator: Signer<'info>,

    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sqrt_u64() {
        assert_eq!(sqrt_u64(0), 0);
        assert_eq!(sqrt_u64(1), 1);
        assert_eq!(sqrt_u64(4), 2);
        assert_eq!(sqrt_u64(9), 3);
        assert_eq!(sqrt_u64(100), 10);
        assert_eq!(sqrt_u64(1_000_000), 1000);
        assert_eq!(sqrt_u64(10_000_000_000), 100_000);
        // Quadratic voting: weight = sqrt(amount)
        let amount: u64 = 50_000 * 1_000_000_000; // 50k TASTE (9 decimals)
        let weight = sqrt_u64(amount);
        assert!(weight > 0 && weight * weight <= amount && (weight + 1) * (weight + 1) > amount);
    }

    #[test]
    fn test_quorum_calculation() {
        // Quorum = sqrt(20% * total_raised). Same units as vote weights (sqrt of lamports).
        let total_raised: u64 = 100_000 * 1_000_000_000; // 100k TASTE
        let quorum_raw = (total_raised as u128 * QUORUM_BPS as u128 / 10_000) as u64;
        assert_eq!(quorum_raw, 20_000 * 1_000_000_000); // 20% of 100k
        let quorum_votes = sqrt_u64(quorum_raw);
        assert!(quorum_votes > 0);
        // If every backer voted with weight = sqrt(contribution), total_votes = sum(sqrt(amounts)).
        // For quorum we need total_votes >= quorum_votes.
        assert!(quorum_votes <= 150_000_000); // sanity: sqrt(20e12) ≈ 4.47e6
    }
}
