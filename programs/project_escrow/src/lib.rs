//! TasteMaker project escrow: hold $TASTE, release on milestone votes (via governance CPI).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Burn, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym");

#[error_code]
pub enum EscrowError {
    #[msg("Milestone percentages must sum to 100")]
    InvalidMilestonePercentages,
    #[msg("Project is not active")]
    ProjectNotActive,
    #[msg("Project deadline has passed")]
    ProjectDeadlinePassed,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid milestone index")]
    InvalidMilestone,
    #[msg("Not all milestones released yet")]
    NotAllMilestonesReleased,
    #[msg("Only the artist can cancel")]
    NotArtist,
    #[msg("Signer is not the backer")]
    NotBacker,
    #[msg("Project is not cancelled")]
    ProjectNotCancelled,
    #[msg("Nothing to refund")]
    NothingToRefund,
    #[msg("Governance authority must sign")]
    GovernanceAuthorityMustSign,
}

pub const MAX_MILESTONES: usize = 5;

#[program]
pub mod project_escrow {
    use super::*;

    pub fn create_project(
        ctx: Context<CreateProject>,
        goal: u64,
        milestone_percentages: [u16; MAX_MILESTONES],
        deadline: i64,
    ) -> Result<()> {
        let sum: u16 = milestone_percentages.iter().sum();
        require!(sum == 100, EscrowError::InvalidMilestonePercentages);
        let project = &mut ctx.accounts.project;
        project.artist = ctx.accounts.artist.key();
        project.goal = goal;
        project.milestone_percentages = milestone_percentages;
        project.deadline = deadline;
        project.status = ProjectStatus::Active;
        project.taste_mint = ctx.accounts.taste_mint.key();
        project.current_milestone = 0;
        let artist_state = &mut ctx.accounts.artist_state;
        if artist_state.project_count == 0 {
            artist_state.artist = ctx.accounts.artist.key();
        }
        artist_state.project_count = artist_state.project_count.checked_add(1).ok_or(EscrowError::Overflow)?;
        msg!("Project created: {} (artist project #{}), {}", project.key(), artist_state.project_count - 1, project.key());
        Ok(())
    }

    pub fn fund_project(ctx: Context<FundProject>, amount: u64) -> Result<()> {
        let project = &ctx.accounts.project;
        require!(project.status == ProjectStatus::Active, EscrowError::ProjectNotActive);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp < project.deadline, EscrowError::ProjectDeadlinePassed);

        // 4% platform fee: 2% treasury, 2% burn, 96% to escrow
        let fee_treasury = (amount as u128)
            .checked_mul(2)
            .ok_or(EscrowError::Overflow)?
            .checked_div(100)
            .ok_or(EscrowError::Overflow)? as u64;
        let fee_burn = (amount as u128)
            .checked_mul(2)
            .ok_or(EscrowError::Overflow)?
            .checked_div(100)
            .ok_or(EscrowError::Overflow)? as u64;
        let to_escrow = amount
            .checked_sub(fee_treasury)
            .ok_or(EscrowError::Overflow)?
            .checked_sub(fee_burn)
            .ok_or(EscrowError::Overflow)?;

        let backer = &mut ctx.accounts.backer;
        let existing = backer.amount;
        backer.amount = existing.checked_add(to_escrow).ok_or(EscrowError::Overflow)?;
        if existing == 0 {
            backer.wallet = ctx.accounts.backer_wallet.key();
            backer.project = project.key();
        }

        let project_acc = &mut ctx.accounts.project;
        project_acc.total_raised = project_acc.total_raised.checked_add(to_escrow).ok_or(EscrowError::Overflow)?;
        if existing == 0 {
            project_acc.backer_count = project_acc.backer_count.checked_add(1).ok_or(EscrowError::Overflow)?;
        }

        let decimals = ctx.accounts.taste_mint.decimals;

        anchor_spl::token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.backer_token_account.to_account_info(),
                    mint: ctx.accounts.taste_mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.backer_wallet.to_account_info(),
                },
            ),
            to_escrow,
            decimals,
        )?;

        if fee_treasury > 0 {
            anchor_spl::token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.backer_token_account.to_account_info(),
                        mint: ctx.accounts.taste_mint.to_account_info(),
                        to: ctx.accounts.platform_treasury.to_account_info(),
                        authority: ctx.accounts.backer_wallet.to_account_info(),
                    },
                ),
                fee_treasury,
                decimals,
            )?;
        }

        if fee_burn > 0 {
            anchor_spl::token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.backer_token_account.to_account_info(),
                        mint: ctx.accounts.taste_mint.to_account_info(),
                        to: ctx.accounts.burn_vault_token_account.to_account_info(),
                        authority: ctx.accounts.backer_wallet.to_account_info(),
                    },
                ),
                fee_burn,
                decimals,
            )?;
            let (_, bump) = Pubkey::find_program_address(&[b"burn_vault"], ctx.program_id);
            let seeds: &[&[u8]] = &[b"burn_vault", &[bump]];
            anchor_spl::token_interface::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.taste_mint.to_account_info(),
                        from: ctx.accounts.burn_vault_token_account.to_account_info(),
                        authority: ctx.accounts.burn_vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                fee_burn,
            )?;
        }

        msg!("Funded project with {} $TASTE ({} to escrow, {} fee)", amount, to_escrow, fee_treasury + fee_burn);
        Ok(())
    }

    pub fn release_milestone(ctx: Context<ReleaseMilestone>) -> Result<()> {
        let project = &mut ctx.accounts.project;
        require!(project.status == ProjectStatus::Active, EscrowError::ProjectNotActive);
        let idx = project.current_milestone as usize;
        require!(idx < MAX_MILESTONES, EscrowError::InvalidMilestone);
        let pct = project.milestone_percentages[idx];
        let amount = (project.total_raised as u128)
            .checked_mul(pct as u128)
            .ok_or(EscrowError::Overflow)?
            .checked_div(100)
            .ok_or(EscrowError::Overflow)? as u64;

        let project_key = project.key();
        let seeds = &[
            b"project",
            project_key.as_ref(),
            &[ctx.bumps.escrow_authority],
        ];
        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.taste_mint.to_account_info(),
                    to: ctx.accounts.artist_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.taste_mint.decimals,
        )?;

        project.current_milestone = project.current_milestone.checked_add(1).ok_or(EscrowError::Overflow)?;
        if project.current_milestone as usize >= MAX_MILESTONES {
            project.status = ProjectStatus::Completed;
        }
        msg!("Released milestone {}: {} $TASTE", idx, amount);
        Ok(())
    }

    pub fn complete_project(ctx: Context<CompleteProject>) -> Result<()> {
        let project = &mut ctx.accounts.project;
        require!(project.status == ProjectStatus::Active, EscrowError::ProjectNotActive);
        require!(
            project.current_milestone as usize >= MAX_MILESTONES,
            EscrowError::NotAllMilestonesReleased
        );
        project.status = ProjectStatus::Completed;
        msg!("Project completed");
        Ok(())
    }

    pub fn cancel_project(ctx: Context<CancelProject>) -> Result<()> {
        let project = &mut ctx.accounts.project;
        require!(project.status == ProjectStatus::Active, EscrowError::ProjectNotActive);
        require!(
            ctx.accounts.artist.key() == project.artist,
            EscrowError::NotArtist
        );
        project.status = ProjectStatus::Cancelled;
        msg!("Project cancelled");
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let project = &ctx.accounts.project;
        require!(project.status == ProjectStatus::Cancelled, EscrowError::ProjectNotCancelled);
        let amount = ctx.accounts.backer.amount;
        require!(amount > 0, EscrowError::NothingToRefund);

        let project_key = project.key();
        let seeds = &[
            b"project",
            project_key.as_ref(),
            &[ctx.bumps.escrow_authority],
        ];
        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.taste_mint.to_account_info(),
                    to: ctx.accounts.backer_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.taste_mint.decimals,
        )?;

        let backer_acc = &mut ctx.accounts.backer;
        backer_acc.amount = 0;
        msg!("Refunded {} $TASTE", amount);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProjectStatus {
    Active,
    Completed,
    Cancelled,
}

#[account]
pub struct Project {
    pub artist: Pubkey,
    pub goal: u64,
    pub milestone_percentages: [u16; MAX_MILESTONES],
    pub deadline: i64,
    pub status: ProjectStatus,
    pub taste_mint: Pubkey,
    pub total_raised: u64,
    pub backer_count: u32,
    pub current_milestone: u8,
}

#[account]
pub struct ArtistState {
    pub artist: Pubkey,
    pub project_count: u64,
}

#[account]
pub struct Backer {
    pub wallet: Pubkey,
    pub project: Pubkey,
    pub amount: u64,
    pub claimed_rwa: bool,
}

#[derive(Accounts)]
pub struct CreateProject<'info> {
    #[account(mut)]
    pub artist: Signer<'info>,

    #[account(
        init_if_needed,
        payer = artist,
        space = 8 + 32 + 8,
        seeds = [b"artist_state", artist.key().as_ref()],
        bump,
    )]
    pub artist_state: Account<'info, ArtistState>,

    #[account(
        init,
        payer = artist,
        space = 8 + 32 + 8 + (2 * MAX_MILESTONES) + 8 + 1 + 32 + 8 + 4 + 1,
        seeds = [b"project", artist.key().as_ref(), artist_state.project_count.to_le_bytes().as_ref()],
        bump,
    )]
    pub project: Account<'info, Project>,

    /// CHECK: PDA for escrow authority
    #[account(seeds = [b"project", project.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = artist,
        token::mint = taste_mint,
        token::authority = escrow_authority,
        seeds = [b"escrow", project.key().as_ref()],
        bump,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    pub taste_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundProject<'info> {
    #[account(mut)]
    pub backer_wallet: Signer<'info>,

    #[account(mut, has_one = taste_mint)]
    pub project: Account<'info, Project>,

    #[account(
        init_if_needed,
        payer = backer_wallet,
        space = 8 + 32 + 32 + 8 + 1,
        seeds = [b"backer", project.key().as_ref(), backer_wallet.key().as_ref()],
        bump,
    )]
    pub backer: Account<'info, Backer>,

    #[account(mut)]
    pub backer_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub platform_treasury: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA validated by seeds
    #[account(seeds = [b"burn_vault"], bump)]
    pub burn_vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = backer_wallet,
        associated_token::mint = taste_mint,
        associated_token::authority = burn_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub burn_vault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub taste_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    pub governance_authority: Signer<'info>,

    #[account(mut)]
    pub project: Account<'info, Project>,

    #[account(mut)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA for escrow authority
    #[account(seeds = [b"project", project.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub artist_token_account: InterfaceAccount<'info, TokenAccount>,

    pub taste_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CompleteProject<'info> {
    pub governance_authority: Signer<'info>,

    #[account(mut)]
    pub project: Account<'info, Project>,
}

#[derive(Accounts)]
pub struct CancelProject<'info> {
    pub artist: Signer<'info>,

    #[account(mut, has_one = artist)]
    pub project: Account<'info, Project>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub backer_wallet: Signer<'info>,

    #[account(mut)]
    pub project: Account<'info, Project>,

    #[account(
        mut,
        has_one = project,
        constraint = backer.wallet == backer_wallet.key() @ EscrowError::NotBacker,
    )]
    pub backer: Account<'info, Backer>,

    #[account(mut)]
    pub backer_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA
    #[account(seeds = [b"project", project.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,

    pub taste_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_milestone_percentages_sum() {
        let valid: [u16; MAX_MILESTONES] = [20, 20, 20, 20, 20];
        assert_eq!(valid.iter().sum::<u16>(), 100);
        let invalid: [u16; MAX_MILESTONES] = [25, 25, 25, 24, 0];
        assert_ne!(invalid.iter().sum::<u16>(), 100);
    }

    #[test]
    fn test_milestone_release_math() {
        // amount = (total_raised * pct) / 100
        let total_raised: u64 = 100_000 * 1_000_000_000; // 100k TASTE (9 decimals)
        let milestone_percentages: [u16; MAX_MILESTONES] = [20, 20, 20, 20, 20];
        let mut released = 0u64;
        for &pct in &milestone_percentages {
            let amount = (total_raised as u128)
                .checked_mul(pct as u128)
                .unwrap()
                .checked_div(100)
                .unwrap() as u64;
            released += amount;
        }
        assert_eq!(released, total_raised);
        assert_eq!(
            (total_raised as u128 * 20 / 100) as u64,
            20_000 * 1_000_000_000
        );
    }
}
