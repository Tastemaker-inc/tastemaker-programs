//! TasteMaker governance: proposals and quadratic voting for milestone release.
//! Adapted from HYPNOSecosystem Governance.sol.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("8NhAWmnGX1dk5AUnt99MMUeZ5rjjtiRGHjrq5eeqsRAC");

/// Upgradeable loader: Program variant.
const UPGRADEABLE_LOADER_PROGRAM_STATE: u8 = 2;
/// Upgradeable loader: ProgramData variant.
const UPGRADEABLE_LOADER_PROGRAM_DATA_STATE: u8 = 3;
const MIN_PROGRAM_ACCOUNT_LEN: usize = 36;
const MIN_PROGRAMDATA_METADATA_LEN: usize = 45;

fn require_upgrade_authority(
    program_id: &Pubkey,
    program_account_key: &Pubkey,
    program_account_data: &[u8],
    program_data_account_key: &Pubkey,
    program_data_account_data: &[u8],
    authority_key: &Pubkey,
) -> Result<()> {
    require!(
        program_account_key == program_id,
        GovError::NotUpgradeAuthority
    );
    require!(
        program_account_data.len() >= MIN_PROGRAM_ACCOUNT_LEN
            && u32::from_le_bytes(program_account_data[0..4].try_into().unwrap())
                == UPGRADEABLE_LOADER_PROGRAM_STATE as u32,
        GovError::NotUpgradeAuthority
    );
    let programdata_address =
        Pubkey::new_from_array(program_account_data[4..36].try_into().unwrap());
    require!(
        program_data_account_key == &programdata_address,
        GovError::NotUpgradeAuthority
    );
    require!(
        program_data_account_data.len() >= MIN_PROGRAMDATA_METADATA_LEN
            && u32::from_le_bytes(program_data_account_data[0..4].try_into().unwrap())
                == UPGRADEABLE_LOADER_PROGRAM_DATA_STATE as u32,
        GovError::NotUpgradeAuthority
    );
    let option_byte = program_data_account_data[12];
    require!(option_byte == 1, GovError::NotUpgradeAuthority);
    let upgrade_authority =
        Pubkey::new_from_array(program_data_account_data[13..45].try_into().unwrap());
    require!(
        upgrade_authority == *authority_key,
        GovError::NotUpgradeAuthority
    );
    Ok(())
}

pub const QUORUM_BPS: u16 = 2000; // 20%
/// Min voting period: 24h in prod; 1s when built with `--features governance/test` for tests.
#[cfg(feature = "test")]
pub const MIN_VOTING_PERIOD_SECS: i64 = 1;
#[cfg(not(feature = "test"))]
pub const MIN_VOTING_PERIOD_SECS: i64 = 24 * 3600;
pub const MAX_PROOF_URI_LEN: usize = 200;

/// If the first remaining_account is the governance config PDA, deserialize and return it; else None.
/// Requires account owner == this program and first 8 bytes match GovConfig Anchor discriminator.
pub(crate) fn read_gov_config_optional<'info>(
    program_id: &Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<Option<GovConfig>> {
    if remaining_accounts.is_empty() {
        return Ok(None);
    }
    let (config_pda, _bump) = Pubkey::find_program_address(&[b"config"], program_id);
    if remaining_accounts[0].key() != config_pda {
        return Ok(None);
    }
    let acc = &remaining_accounts[0];
    if acc.owner != program_id {
        return Ok(None);
    }
    if acc.data_len() < 17 {
        return Ok(None);
    }
    let data = acc.try_borrow_data()?;
    if &data[0..8] != GovConfig::DISCRIMINATOR {
        return Ok(None);
    }
    let allow_early_finalize = data[8] != 0;
    let min_voting_period_secs = i64::from_le_bytes(data[9..17].try_into().unwrap());
    Ok(Some(GovConfig {
        allow_early_finalize,
        min_voting_period_secs,
    }))
}

/// Read optional GovConfig and optional total_vote_weight from remaining_accounts for early-finalize.
/// remaining_accounts[0] = gov config PDA (this program), remaining_accounts[1] = project_escrow ProjectVoteWeight PDA.
/// Each account is only parsed when owner and Anchor discriminator match; otherwise treated as not provided.
pub(crate) fn read_early_finalize_params<'info>(
    program_id: &Pubkey,
    project_escrow_program_id: &Pubkey,
    project_key: &Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<(Option<GovConfig>, Option<u64>)> {
    let mut gov_config = None;
    let mut total_vote_weight = None;
    let (config_pda, _) = Pubkey::find_program_address(&[b"config"], program_id);
    let (vote_weight_pda, _) = Pubkey::find_program_address(
        &[b"vote_weight", project_key.as_ref()],
        project_escrow_program_id,
    );
    // Presence-based inclusion: accept either order, but still validate owner + discriminator.
    for acc in remaining_accounts {
        if gov_config.is_none()
            && acc.key() == config_pda
            && acc.owner == program_id
            && acc.data_len() >= 17
        {
            let data = acc.try_borrow_data()?;
            if &data[0..8] == GovConfig::DISCRIMINATOR {
                gov_config = Some(GovConfig {
                    allow_early_finalize: data[8] != 0,
                    min_voting_period_secs: i64::from_le_bytes(data[9..17].try_into().unwrap()),
                });
            }
        }
        if total_vote_weight.is_none()
            && acc.key() == vote_weight_pda
            && acc.owner == project_escrow_program_id
            && acc.data_len() >= 16
        {
            let data = acc.try_borrow_data()?;
            if &data[0..8] == project_escrow::ProjectVoteWeight::DISCRIMINATOR {
                total_vote_weight = Some(u64::from_le_bytes(data[8..16].try_into().unwrap()));
            }
        }
    }
    Ok((gov_config, total_vote_weight))
}

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

    /// One-time init: set allow_early_finalize and min_voting_period_secs. Only upgrade authority.
    pub fn initialize_config(
        ctx: Context<InitializeGovConfig>,
        allow_early_finalize: bool,
        min_voting_period_secs: i64,
    ) -> Result<()> {
        let program_account = ctx.accounts.program_account.try_borrow_data()?;
        let program_data_account = ctx.accounts.program_data_account.try_borrow_data()?;
        require_upgrade_authority(
            ctx.program_id,
            &ctx.accounts.program_account.key(),
            &program_account,
            &ctx.accounts.program_data_account.key(),
            &program_data_account,
            &ctx.accounts.authority.key(),
        )?;
        require!(min_voting_period_secs >= 1, GovError::VotingPeriodTooShort);
        let config = &mut ctx.accounts.config;
        config.allow_early_finalize = allow_early_finalize;
        config.min_voting_period_secs = min_voting_period_secs;
        msg!(
            "Gov config initialized: allow_early_finalize={} min_voting_period_secs={}",
            allow_early_finalize,
            min_voting_period_secs
        );
        Ok(())
    }

    /// Update config (allow_early_finalize, min_voting_period_secs). Only upgrade authority.
    pub fn update_config(
        ctx: Context<UpdateGovConfig>,
        allow_early_finalize: bool,
        min_voting_period_secs: i64,
    ) -> Result<()> {
        let program_account = ctx.accounts.program_account.try_borrow_data()?;
        let program_data_account = ctx.accounts.program_data_account.try_borrow_data()?;
        require_upgrade_authority(
            ctx.program_id,
            &ctx.accounts.program_account.key(),
            &program_account,
            &ctx.accounts.program_data_account.key(),
            &program_data_account,
            &ctx.accounts.authority.key(),
        )?;
        require!(min_voting_period_secs >= 1, GovError::VotingPeriodTooShort);
        let config = &mut ctx.accounts.config;
        config.allow_early_finalize = allow_early_finalize;
        config.min_voting_period_secs = min_voting_period_secs;
        msg!(
            "Gov config updated: allow_early_finalize={} min_voting_period_secs={}",
            allow_early_finalize,
            min_voting_period_secs
        );
        Ok(())
    }

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        project_key: Pubkey,
        milestone_index: u8,
        proof_uri: String,
        voting_period_secs: i64,
        attempt: u64,
    ) -> Result<()> {
        let min_required = if let Some(config) =
            read_gov_config_optional(ctx.program_id, ctx.remaining_accounts)?
        {
            config.min_voting_period_secs
        } else {
            MIN_VOTING_PERIOD_SECS
        };
        require!(
            voting_period_secs >= min_required,
            GovError::VotingPeriodTooShort
        );
        // 0..5 = milestone release; 255 = material edit proposal
        require!(
            milestone_index < 5 || milestone_index == 255,
            GovError::InvalidMilestoneIndex
        );

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
        msg!(
            "Proposal created: project {} milestone {} proof_uri_len {}",
            project_key,
            milestone_index,
            p.proof_uri.len()
        );
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
        let side_str = if side { "for" } else { "against" };
        msg!(
            "Vote cast: proposal {} side {} weight {}",
            ctx.accounts.proposal.key(),
            side_str,
            weight
        );
        Ok(())
    }

    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        let clock = Clock::get()?;

        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .ok_or(GovError::Overflow)?;
        let project = &ctx.accounts.project;
        let total_escrowed = project.total_raised;
        let quorum_raw = (total_escrowed as u128 * QUORUM_BPS as u128 / 10_000) as u64;
        let quorum_votes = sqrt_u64(quorum_raw);
        require!(total_votes >= quorum_votes, GovError::QuorumNotMet);

        let (gov_config, total_vote_weight) = read_early_finalize_params(
            ctx.program_id,
            &ctx.accounts.project_escrow_program.key(),
            &ctx.accounts.project.key(),
            ctx.remaining_accounts,
        )?;
        let voting_ended = clock.unix_timestamp >= proposal.end_ts;
        let outcome_decided = if let Some(tw) = total_vote_weight {
            if tw == 0 {
                false
            } else {
                let two_for = (proposal.votes_for as u128) * 2;
                let two_against = (proposal.votes_against as u128) * 2;
                let tw = tw as u128;
                (two_for > tw) || (two_against >= tw)
            }
        } else {
            false
        };
        let early_ok = gov_config
            .as_ref()
            .map(|c| c.allow_early_finalize)
            .unwrap_or(false)
            && total_vote_weight.is_some()
            && outcome_decided;
        require!(voting_ended || early_ok, GovError::VotingNotEnded);

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
        let status_str = if passed { "Passed" } else { "Rejected" };
        msg!(
            "Proposal finalized: {} status {}",
            ctx.accounts.proposal.key(),
            status_str
        );
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
        msg!("Proposal cancelled: {}", ctx.accounts.proposal.key());
        Ok(())
    }

    /// Finalize a material-edit proposal (milestone_index == 255). On pass, CPIs project_escrow::apply_material_edit.
    pub fn finalize_material_edit_proposal(
        ctx: Context<FinalizeMaterialEditProposal>,
        new_terms_hash: [u8; 32],
        refund_window_secs: i64,
        new_goal: u64,
        new_deadline: i64,
        new_milestone_percentages: [u16; 5],
    ) -> Result<()> {
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.milestone_index == 255,
            GovError::InvalidMilestoneIndex
        );
        require!(
            proposal.status == ProposalStatus::Active,
            GovError::ProposalNotActive
        );
        let clock = Clock::get()?;

        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .ok_or(GovError::Overflow)?;
        let project = &ctx.accounts.project;
        let total_escrowed = project.total_raised;
        let quorum_raw = (total_escrowed as u128 * QUORUM_BPS as u128 / 10_000) as u64;
        let quorum_votes = sqrt_u64(quorum_raw);
        require!(total_votes >= quorum_votes, GovError::QuorumNotMet);

        let (gov_config, total_vote_weight) = read_early_finalize_params(
            ctx.program_id,
            &ctx.accounts.project_escrow_program.key(),
            &ctx.accounts.project.key(),
            ctx.remaining_accounts,
        )?;
        let voting_ended = clock.unix_timestamp >= proposal.end_ts;
        let outcome_decided = if let Some(tw) = total_vote_weight {
            if tw == 0 {
                false
            } else {
                let two_for = (proposal.votes_for as u128) * 2;
                let two_against = (proposal.votes_against as u128) * 2;
                let tw = tw as u128;
                (two_for > tw) || (two_against >= tw)
            }
        } else {
            false
        };
        let early_ok = gov_config
            .as_ref()
            .map(|c| c.allow_early_finalize)
            .unwrap_or(false)
            && total_vote_weight.is_some()
            && outcome_decided;
        require!(voting_ended || early_ok, GovError::VotingNotEnded);

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
                project_escrow::cpi::accounts::ApplyMaterialEdit {
                    governance_authority: ctx.accounts.release_authority.to_account_info(),
                    config: ctx.accounts.escrow_config.to_account_info(),
                    project: ctx.accounts.project.to_account_info(),
                    project_terms: ctx.accounts.project_terms.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                signer_seeds,
            );
            project_escrow::cpi::apply_material_edit(
                cpi_ctx,
                new_terms_hash,
                refund_window_secs,
                new_goal,
                new_deadline,
                new_milestone_percentages,
            )?;
        }
        let status_str = if passed { "Passed" } else { "Rejected" };
        msg!(
            "Material-edit proposal finalized: {} status {}",
            ctx.accounts.proposal.key(),
            status_str
        );
        Ok(())
    }
}

#[error_code]
pub enum GovError {
    #[msg("Only program upgrade authority can initialize or update config")]
    NotUpgradeAuthority,
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

/// Optional governance config (seeds = [b"config"]). When set, allows early finalize and custom min voting period.
#[account]
pub struct GovConfig {
    pub allow_early_finalize: bool,
    pub min_voting_period_secs: i64,
}

#[derive(Accounts)]
pub struct InitializeGovConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + 1 + 8,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, GovConfig>,

    /// CHECK: validated in instruction
    pub program_account: UncheckedAccount<'info>,

    /// CHECK: validated in instruction
    pub program_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateGovConfig<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, GovConfig>,

    /// CHECK: validated in instruction
    pub program_account: UncheckedAccount<'info>,

    /// CHECK: validated in instruction
    pub program_data_account: UncheckedAccount<'info>,
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
    #[account(mut, seeds = [b"release_authority"], bump)]
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

#[derive(Accounts)]
pub struct FinalizeMaterialEditProposal<'info> {
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,

    #[account(mut)]
    pub project: Account<'info, project_escrow::Project>,

    /// PDA that signs for governance CPI to project_escrow
    /// CHECK: validated by seeds
    #[account(mut, seeds = [b"release_authority"], bump)]
    pub release_authority: UncheckedAccount<'info>,

    #[account(
        constraint = escrow_config.key() == Pubkey::find_program_address(&[b"config"], &project_escrow_program.key()).0
    )]
    pub escrow_config: Account<'info, project_escrow::Config>,

    /// ProjectTerms PDA (seeds = [b"project_terms", project.key()]). May be uninitialized; project_escrow will init_if_needed.
    /// CHECK: validated by project_escrow CPI
    #[account(mut)]
    pub project_terms: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    pub project_escrow_program: Program<'info, project_escrow::program::ProjectEscrow>,
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

    #[test]
    fn test_read_gov_config_optional_empty_remaining_accounts() {
        let program_id = crate::ID;
        let out = read_gov_config_optional(&program_id, &[]).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn test_read_early_finalize_params_empty_remaining_accounts() {
        let program_id = crate::ID;
        let project_escrow_program_id = Pubkey::new_unique();
        let project_key = Pubkey::new_unique();
        let (gov, tw) =
            read_early_finalize_params(&program_id, &project_escrow_program_id, &project_key, &[])
                .unwrap();
        assert!(gov.is_none());
        assert!(tw.is_none());
    }
}
