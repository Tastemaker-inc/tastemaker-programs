//! TasteMaker per-project RWA token. Mint on project completion; backers claim (pull).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, MintTo, TokenAccount, TokenInterface};
use project_escrow::{Backer, Project, ProjectStatus};

declare_id!("GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE");

#[program]
pub mod rwa_token {
    use super::*;

    pub fn initialize_rwa_mint(
        ctx: Context<InitializeRwaMint>,
        total_supply: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.project.status == ProjectStatus::Completed,
            RwaError::ProjectNotCompleted
        );
        let state = &mut ctx.accounts.rwa_state;
        state.project = ctx.accounts.project.key();
        state.authority = ctx.accounts.authority.key();
        state.total_supply = total_supply;
        state.minted = 0;
        state.mint_frozen = false;
        msg!("RWA mint initialized for project {}", state.project);
        Ok(())
    }

    pub fn claim_rwa_tokens(ctx: Context<ClaimRwaTokens>) -> Result<()> {
        let is_frozen = ctx.accounts.rwa_state.mint_frozen;
        let total_supply = ctx.accounts.rwa_state.total_supply;
        let project_key = ctx.accounts.rwa_state.project;
        let current_minted = ctx.accounts.rwa_state.minted;

        require!(!is_frozen, RwaError::MintFrozen);
        require!(
            ctx.accounts.project.status == ProjectStatus::Completed,
            RwaError::ProjectNotCompleted
        );

        let backer_account = &ctx.accounts.backer_account;
        require!(backer_account.wallet == ctx.accounts.backer.key(), RwaError::NotBacker);
        require!(backer_account.project == project_key, RwaError::WrongProject);
        require!(backer_account.amount > 0, RwaError::NoContribution);

        let total_raised = ctx.accounts.project.total_raised;
        require!(total_raised > 0, RwaError::InvalidAmounts);

        require!(!ctx.accounts.claim_record.claimed, RwaError::AlreadyClaimed);

        let share = (backer_account.amount as u128)
            .checked_mul(total_supply as u128)
            .ok_or(RwaError::Overflow)?
            .checked_div(total_raised as u128)
            .ok_or(RwaError::Overflow)? as u64;

        require!(share > 0, RwaError::ZeroShare);

        let new_minted = current_minted.checked_add(share).ok_or(RwaError::Overflow)?;
        require!(new_minted <= total_supply, RwaError::ExceedsSupply);

        ctx.accounts.rwa_state.minted = new_minted;
        ctx.accounts.claim_record.claimed = true;

        let (_, bump) = Pubkey::find_program_address(
            &[b"rwa_mint_authority", project_key.as_ref()],
            ctx.program_id,
        );
        let seeds: &[&[u8]] = &[b"rwa_mint_authority", project_key.as_ref(), &[bump]];
        let signer_seeds = &[seeds];

        let cpi_accounts = MintTo {
            mint: ctx.accounts.rwa_mint.to_account_info(),
            to: ctx.accounts.backer_token_account.to_account_info(),
            authority: ctx.accounts.rwa_mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        anchor_spl::token_interface::mint_to(cpi_ctx, share)?;
        msg!("Claimed {} RWA tokens", share);
        Ok(())
    }

    pub fn close_distribution(ctx: Context<CloseDistribution>) -> Result<()> {
        let state = &mut ctx.accounts.rwa_state;
        require!(!state.mint_frozen, RwaError::MintFrozen);
        require!(
            ctx.accounts.authority.key() == state.authority,
            RwaError::NotAuthority
        );
        state.mint_frozen = true;
        msg!("RWA mint frozen");
        Ok(())
    }
}

#[error_code]
pub enum RwaError {
    #[msg("Mint is frozen")]
    MintFrozen,
    #[msg("Invalid amounts")]
    InvalidAmounts,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Share is zero")]
    ZeroShare,
    #[msg("Exceeds total supply")]
    ExceedsSupply,
    #[msg("Signer is not the backer")]
    NotBacker,
    #[msg("Backer is not for this project")]
    WrongProject,
    #[msg("No contribution in this project")]
    NoContribution,
    #[msg("Already claimed RWA for this project")]
    AlreadyClaimed,
    #[msg("Only RWA authority can close distribution")]
    NotAuthority,
    #[msg("Project not completed")]
    ProjectNotCompleted,
}

#[account]
pub struct RwaState {
    pub project: Pubkey,
    pub authority: Pubkey,
    pub total_supply: u64,
    pub minted: u64,
    pub mint_frozen: bool,
}

#[account]
pub struct ClaimRecord {
    pub claimed: bool,
}

#[derive(Accounts)]
pub struct InitializeRwaMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub project: Account<'info, Project>,

    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 8 + 8 + 1,
        seeds = [b"rwa_state", project.key().as_ref()],
        bump,
    )]
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = rwa_mint_authority,
        mint::freeze_authority = rwa_mint_authority,
        seeds = [b"rwa_mint", project.key().as_ref()],
        bump,
    )]
    pub rwa_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA validated by seeds
    #[account(seeds = [b"rwa_mint_authority", project.key().as_ref()], bump)]
    pub rwa_mint_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRwaTokens<'info> {
    #[account(mut)]
    pub backer: Signer<'info>,

    #[account(
        constraint = backer_account.wallet == backer.key(),
        constraint = backer_account.project == rwa_state.project,
    )]
    pub backer_account: Account<'info, Backer>,

    #[account(constraint = project.key() == rwa_state.project)]
    pub project: Account<'info, Project>,

    #[account(mut)]
    pub rwa_state: Account<'info, RwaState>,

    #[account(mut)]
    pub rwa_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA for mint authority
    #[account(seeds = [b"rwa_mint_authority", rwa_state.project.as_ref()], bump)]
    pub rwa_mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = backer,
        space = 8 + 1,
        seeds = [b"claim", rwa_state.project.as_ref(), backer.key().as_ref()],
        bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    #[account(
        init_if_needed,
        payer = backer,
        associated_token::mint = rwa_mint,
        associated_token::authority = backer,
        associated_token::token_program = token_program,
    )]
    pub backer_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseDistribution<'info> {
    pub authority: Signer<'info>,

    #[account(mut)]
    pub rwa_state: Account<'info, RwaState>,
}
