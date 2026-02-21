//! TasteMaker RWA revenue distribution.
//! Artist deposits TASTE; holders claim proportional share based on RWA token balance.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked};

use project_escrow::{Project, ProjectStatus};
use rwa_token::RwaState;

#[cfg(not(feature = "devnet"))]
declare_id!("4RXKpphnRMC4yTpkjVLKQqMgFdHere6kC3BjZssPQmfR");
#[cfg(feature = "devnet")]
declare_id!("6bckDfoEDZWgZXU66fL2Sq6pjFmqxk3JVZEs2YVYMLc3");

#[program]
pub mod revenue_distribution {
    use super::*;

    /// Initialize revenue distribution for a completed project. One-time setup.
    pub fn initialize_revenue_config(ctx: Context<InitializeRevenueConfig>) -> Result<()> {
        require!(
            ctx.accounts.project.status == ProjectStatus::Completed,
            RevError::ProjectNotCompleted
        );
        require!(
            ctx.accounts.rwa_state.minted > 0,
            RevError::NoRwaTokensMinted
        );

        let config = &mut ctx.accounts.rev_config;
        config.project = ctx.accounts.project.key();
        config.rwa_mint = ctx.accounts.rwa_mint.key();
        config.taste_mint = ctx.accounts.taste_mint.key();
        config.artist_authority = ctx.accounts.project.artist;
        config.total_distributed = 0;
        config.epoch_count = 0;

        msg!(
            "Revenue config initialized for project {}",
            config.project
        );
        Ok(())
    }

    /// Artist deposits TASTE into the revenue vault. Creates a new distribution epoch.
    pub fn deposit_revenue(ctx: Context<DepositRevenue>, amount: u64) -> Result<()> {
        require!(amount > 0, RevError::InvalidAmount);
        require!(
            ctx.accounts.artist_authority.key() == ctx.accounts.rev_config.artist_authority,
            RevError::NotArtist
        );

        let config = &mut ctx.accounts.rev_config;
        let epoch_index = config.epoch_count;
        config.epoch_count = epoch_index.checked_add(1).ok_or(RevError::Overflow)?;

        let epoch = &mut ctx.accounts.distribution_epoch;
        epoch.project = config.project;
        epoch.epoch_index = epoch_index;
        epoch.amount = amount;
        epoch.total_rwa_supply = ctx.accounts.rwa_state.minted;
        epoch.claimed_count = 0;
        epoch.total_claimed = 0;

        anchor_spl::token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.artist_source.to_account_info(),
                    mint: ctx.accounts.taste_mint.to_account_info(),
                    to: ctx.accounts.rev_vault.to_account_info(),
                    authority: ctx.accounts.artist_authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.taste_mint.decimals,
        )?;

        config.total_distributed = config
            .total_distributed
            .checked_add(amount)
            .ok_or(RevError::Overflow)?;

        msg!(
            "Deposited {} TASTE for project {} epoch {}",
            amount,
            config.project,
            epoch_index
        );
        Ok(())
    }

    /// Holder claims their proportional share for a specific epoch.
    pub fn claim_revenue(ctx: Context<ClaimRevenue>) -> Result<()> {
        let config = &ctx.accounts.rev_config;
        let epoch = &mut ctx.accounts.distribution_epoch;

        require!(
            epoch.project == config.project,
            RevError::EpochMismatch
        );
        require!(epoch.total_rwa_supply > 0, RevError::ZeroSupply);

        let holder_balance = ctx.accounts.holder_rwa_account.amount;
        require!(holder_balance > 0, RevError::NoRwaBalance);

        let share = (holder_balance as u128)
            .checked_mul(epoch.amount as u128)
            .ok_or(RevError::Overflow)?
            .checked_div(epoch.total_rwa_supply as u128)
            .ok_or(RevError::Overflow)? as u64;

        require!(share > 0, RevError::ZeroShare);

        if ctx.accounts.holder_claim.claimed {
            return Err(RevError::AlreadyClaimed.into());
        }

        ctx.accounts.holder_claim.claimed = true;
        ctx.accounts.holder_claim.amount = share;
        epoch.claimed_count = epoch.claimed_count.checked_add(1).ok_or(RevError::Overflow)?;
        epoch.total_claimed = epoch.total_claimed.checked_add(share).ok_or(RevError::Overflow)?;

        let (vault_authority, bump) = Pubkey::find_program_address(
            &[b"rev_vault", config.project.as_ref()],
            ctx.program_id,
        );
        let seeds: &[&[u8]] = &[b"rev_vault", config.project.as_ref(), &[bump]];

        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.rev_vault.to_account_info(),
                    mint: ctx.accounts.taste_mint.to_account_info(),
                    to: ctx.accounts.holder_dest.to_account_info(),
                    authority: ctx.accounts.rev_vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            share,
            ctx.accounts.taste_mint.decimals,
        )?;

        msg!(
            "Claimed {} TASTE for holder {} epoch {}",
            share,
            ctx.accounts.holder.key(),
            epoch.epoch_index
        );
        Ok(())
    }

    /// Authority closes an epoch after claim deadline, sweeping unclaimed funds to artist.
    pub fn close_epoch(ctx: Context<CloseEpoch>) -> Result<()> {
        let config = &ctx.accounts.rev_config;
        let epoch = &ctx.accounts.distribution_epoch;

        require!(
            ctx.accounts.authority.key() == config.artist_authority,
            RevError::NotArtist
        );
        require!(
            epoch.project == config.project,
            RevError::EpochMismatch
        );

        let remaining = epoch.amount.saturating_sub(epoch.total_claimed);

        if remaining > 0 {
            let (vault_authority, bump) = Pubkey::find_program_address(
                &[b"rev_vault", config.project.as_ref()],
                ctx.program_id,
            );
            let seeds: &[&[u8]] = &[b"rev_vault", config.project.as_ref(), &[bump]];

            anchor_spl::token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.rev_vault.to_account_info(),
                        mint: ctx.accounts.taste_mint.to_account_info(),
                        to: ctx.accounts.artist_dest.to_account_info(),
                        authority: ctx.accounts.rev_vault_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                remaining,
                ctx.accounts.taste_mint.decimals,
            )?;
        }

        msg!("Closed epoch {} for project {}", epoch.epoch_index, config.project);
        Ok(())
    }
}

#[error_code]
pub enum RevError {
    #[msg("Project not completed")]
    ProjectNotCompleted,
    #[msg("No RWA tokens minted yet")]
    NoRwaTokensMinted,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Not the project artist")]
    NotArtist,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Epoch mismatch")]
    EpochMismatch,
    #[msg("Zero RWA supply in epoch")]
    ZeroSupply,
    #[msg("Holder has no RWA balance")]
    NoRwaBalance,
    #[msg("Zero share")]
    ZeroShare,
    #[msg("Already claimed for this epoch")]
    AlreadyClaimed,
}

#[account]
pub struct RevenueConfig {
    pub project: Pubkey,
    pub rwa_mint: Pubkey,
    pub taste_mint: Pubkey,
    pub artist_authority: Pubkey,
    pub total_distributed: u64,
    pub epoch_count: u64,
}

#[account]
pub struct DistributionEpoch {
    pub project: Pubkey,
    pub epoch_index: u64,
    pub amount: u64,
    pub total_rwa_supply: u64,
    pub claimed_count: u64,
    pub total_claimed: u64,
}

#[account]
pub struct HolderClaim {
    pub claimed: bool,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct InitializeRevenueConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub project: Account<'info, Project>,
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 32 + 32 + 8 + 8,
        seeds = [b"rev_config", project.key().as_ref()],
        bump,
    )]
    pub rev_config: Account<'info, RevenueConfig>,

    /// CHECK: Validated by constraint to match rwa_token's rwa_mint PDA for this project.
    #[account(
        constraint = rwa_mint.key() == Pubkey::find_program_address(&[b"rwa_mint", project.key().as_ref()], &rwa_token::ID).0
    )]
    pub rwa_mint: UncheckedAccount<'info>,

    /// CHECK: PDA for vault authority
    #[account(
        seeds = [b"rev_vault", project.key().as_ref()],
        bump,
    )]
    pub rev_vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = taste_mint,
        associated_token::authority = rev_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub rev_vault: InterfaceAccount<'info, TokenAccount>,

    pub taste_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct DepositRevenue<'info> {
    #[account(mut)]
    pub artist_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"rev_config", rev_config.project.as_ref()],
        bump,
    )]
    pub rev_config: Account<'info, RevenueConfig>,

    pub project: Account<'info, Project>,
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        init,
        payer = artist_authority,
        space = 8 + 32 + 8 + 8 + 8 + 8 + 8,
        seeds = [
            b"epoch",
            rev_config.project.as_ref(),
            &rev_config.epoch_count.to_le_bytes(),
        ],
        bump,
    )]
    pub distribution_epoch: Account<'info, DistributionEpoch>,

    #[account(
        mut,
        constraint = artist_source.owner == artist_authority.key(),
        constraint = artist_source.mint == taste_mint.key(),
    )]
    pub artist_source: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = taste_mint,
        associated_token::authority = rev_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub rev_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA for vault authority
    #[account(
        seeds = [b"rev_vault", rev_config.project.as_ref()],
        bump,
    )]
    pub rev_vault_authority: UncheckedAccount<'info>,

    pub taste_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRevenue<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(
        seeds = [b"rev_config", rev_config.project.as_ref()],
        bump,
    )]
    pub rev_config: Box<Account<'info, RevenueConfig>>,

    #[account(
        mut,
        seeds = [
            b"epoch",
            rev_config.project.as_ref(),
            &distribution_epoch.epoch_index.to_le_bytes(),
        ],
        bump,
    )]
    pub distribution_epoch: Box<Account<'info, DistributionEpoch>>,

    #[account(
        constraint = holder_rwa_account.owner == holder.key(),
        constraint = holder_rwa_account.mint == rev_config.rwa_mint,
    )]
    pub holder_rwa_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_dest.owner == holder.key(),
        constraint = holder_dest.mint == taste_mint.key(),
    )]
    pub holder_dest: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = holder,
        space = 8 + 1 + 8,
        seeds = [
            b"holder_claim",
            rev_config.project.as_ref(),
            &distribution_epoch.epoch_index.to_le_bytes(),
            holder.key().as_ref(),
        ],
        bump,
    )]
    pub holder_claim: Box<Account<'info, HolderClaim>>,

    /// CHECK: PDA for vault authority
    #[account(
        seeds = [b"rev_vault", rev_config.project.as_ref()],
        bump,
    )]
    pub rev_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = taste_mint,
        associated_token::authority = rev_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub rev_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub taste_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseEpoch<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"rev_config", rev_config.project.as_ref()],
        bump,
    )]
    pub rev_config: Account<'info, RevenueConfig>,

    pub distribution_epoch: Account<'info, DistributionEpoch>,

    /// CHECK: vault authority PDA
    #[account(
        seeds = [b"rev_vault", rev_config.project.as_ref()],
        bump,
    )]
    pub rev_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = taste_mint,
        associated_token::authority = rev_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub rev_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub artist_dest: InterfaceAccount<'info, TokenAccount>,

    pub taste_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
}
