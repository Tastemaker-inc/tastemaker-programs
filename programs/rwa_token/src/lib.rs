//! TasteMaker per-project RWA token. Mint on project completion; backers claim (pull).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Burn, Mint, MintTo, TokenAccount, TokenInterface};
use mpl_token_metadata::{
    accounts::Metadata, instructions::CreateV1CpiBuilder, types::TokenStandard,
    ID as MPL_TOKEN_METADATA_ID,
};
use project_escrow::{Backer, Project, ProjectStatus};

// Anchor programs must be deployed at their declared ID.
// We support devnet vs localnet IDs via a build-time feature so CI/local tests keep working.
// Localnet first so `anchor keys sync` updates it to match target/deploy keypairs; build (no devnet) then uses keypair ID.
#[cfg(not(feature = "devnet"))]
declare_id!("AaDWsS3FuXrj9A48vAwycTbY6vE2Qa2iMMRhMPdMcoYG");
#[cfg(feature = "devnet")]
declare_id!("GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE");

/// Max lengths for RWA metadata (aligned with Metaplex Token Metadata).
const MAX_NAME_LEN: usize = 32;
const MAX_SYMBOL_LEN: usize = 10;
const MAX_URI_LEN: usize = 200;

#[program]
pub mod rwa_token {
    use super::*;

    pub fn initialize_rwa_mint(ctx: Context<InitializeRwaMint>, total_supply: u64) -> Result<()> {
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

    /// Called by governance when the last milestone is released (project becomes Completed).
    /// Only the config's governance_release_authority may call this.
    pub fn initialize_rwa_mint_by_governance(
        ctx: Context<InitializeRwaMintByGovernance>,
        total_supply: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.release_authority.key()
                == ctx.accounts.config.governance_release_authority,
            RwaError::NotReleaseAuthority
        );
        require!(
            ctx.accounts.project.status == ProjectStatus::Completed,
            RwaError::ProjectNotCompleted
        );
        let state = &mut ctx.accounts.rwa_state;
        state.project = ctx.accounts.project.key();
        state.authority = ctx.accounts.project.artist;
        state.total_supply = total_supply;
        state.minted = 0;
        state.mint_frozen = false;
        msg!(
            "RWA mint initialized by governance for project {}",
            state.project
        );
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
        require!(
            backer_account.wallet == ctx.accounts.backer.key(),
            RwaError::NotBacker
        );
        require!(
            backer_account.project == project_key,
            RwaError::WrongProject
        );
        require!(backer_account.amount > 0, RwaError::NoContribution);

        // Require and burn on-chain receipt: receipt mint must be project_escrow PDA [b"receipt", project, backer].
        require!(
            ctx.accounts.project_escrow_program.key() == project_escrow::ID,
            RwaError::InvalidReceipt
        );
        let (expected_receipt_mint, _) = Pubkey::find_program_address(
            &[
                b"receipt",
                project_key.as_ref(),
                ctx.accounts.backer.key().as_ref(),
            ],
            &ctx.accounts.project_escrow_program.key(),
        );
        require!(
            ctx.accounts.receipt_mint.key() == expected_receipt_mint,
            RwaError::InvalidReceipt
        );
        require!(
            ctx.accounts.receipt_token_account.amount >= 1,
            RwaError::InvalidReceipt
        );
        anchor_spl::token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    from: ctx.accounts.receipt_token_account.to_account_info(),
                    mint: ctx.accounts.receipt_mint.to_account_info(),
                    authority: ctx.accounts.backer.to_account_info(),
                },
            ),
            1,
        )?;

        let total_raised = ctx.accounts.project.total_raised;
        require!(total_raised > 0, RwaError::InvalidAmounts);

        require!(!ctx.accounts.claim_record.claimed, RwaError::AlreadyClaimed);

        let share = (backer_account.amount as u128)
            .checked_mul(total_supply as u128)
            .ok_or(RwaError::Overflow)?
            .checked_div(total_raised as u128)
            .ok_or(RwaError::Overflow)? as u64;

        require!(share > 0, RwaError::ZeroShare);

        let new_minted = current_minted
            .checked_add(share)
            .ok_or(RwaError::Overflow)?;
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

    /// Claim RWA tokens for backers who funded before on-chain receipts existed (no receipt to burn).
    pub fn claim_rwa_tokens_legacy(ctx: Context<ClaimRwaTokensLegacy>) -> Result<()> {
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
        require!(
            backer_account.wallet == ctx.accounts.backer.key(),
            RwaError::NotBacker
        );
        require!(
            backer_account.project == project_key,
            RwaError::WrongProject
        );
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

        let new_minted = current_minted
            .checked_add(share)
            .ok_or(RwaError::Overflow)?;
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
        msg!("Claimed {} RWA tokens (legacy)", share);
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

    /// One-time init of Metaplex Token Metadata for the RWA mint. Callable only by `rwa_state.authority`.
    /// Name/symbol/uri are bounded; second call fails (metadata guard prevents re-init).
    pub fn initialize_rwa_metadata(
        ctx: Context<InitializeRwaMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let state = &ctx.accounts.rwa_state;
        require!(
            ctx.accounts.authority.key() == state.authority,
            RwaError::NotAuthority
        );

        require!(name.len() <= MAX_NAME_LEN, RwaError::MetadataNameTooLong);
        require!(
            symbol.len() <= MAX_SYMBOL_LEN,
            RwaError::MetadataSymbolTooLong
        );
        require!(uri.len() <= MAX_URI_LEN, RwaError::MetadataUriTooLong);

        let (metadata_pda, _) = Metadata::find_pda(&ctx.accounts.rwa_mint.key());
        require!(
            ctx.accounts.metadata.key() == metadata_pda,
            RwaError::InvalidMetadataAccount
        );
        require!(
            ctx.accounts.token_metadata_program.key() == MPL_TOKEN_METADATA_ID,
            RwaError::InvalidTokenMetadataProgram
        );

        let mint_key = ctx.accounts.rwa_mint.key();
        let (_, bump) = Pubkey::find_program_address(
            &[b"rwa_mint_authority", state.project.as_ref()],
            ctx.program_id,
        );
        let authority_seeds: &[&[u8]] = &[b"rwa_mint_authority", state.project.as_ref(), &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

        CreateV1CpiBuilder::new(ctx.accounts.token_metadata_program.as_ref())
            .metadata(ctx.accounts.metadata.as_ref())
            .master_edition(None)
            .mint(ctx.accounts.rwa_mint.as_ref(), false)
            .authority(ctx.accounts.rwa_mint_authority.as_ref())
            .payer(ctx.accounts.authority.as_ref())
            .update_authority(ctx.accounts.authority.as_ref(), true)
            .system_program(ctx.accounts.system_program.as_ref())
            .sysvar_instructions(ctx.accounts.sysvar_instructions.as_ref())
            .spl_token_program(Some(ctx.accounts.token_program.as_ref()))
            .name(name)
            .symbol(symbol)
            .uri(uri)
            .seller_fee_basis_points(0)
            .primary_sale_happened(false)
            .is_mutable(true)
            .token_standard(TokenStandard::Fungible)
            .invoke_signed(signer_seeds)?;

        msg!("RWA metadata initialized for mint {}", mint_key);
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
    #[msg("Metadata name too long")]
    MetadataNameTooLong,
    #[msg("Metadata symbol too long")]
    MetadataSymbolTooLong,
    #[msg("Metadata URI too long")]
    MetadataUriTooLong,
    #[msg("Invalid metadata account")]
    InvalidMetadataAccount,
    #[msg("Invalid token metadata program")]
    InvalidTokenMetadataProgram,
    #[msg("Signer is not the governance release authority")]
    NotReleaseAuthority,
    #[msg("Receipt mint or token account invalid; must hold 1 receipt to claim")]
    InvalidReceipt,
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

/// One-time guard: once this PDA exists, initialize_rwa_metadata cannot run again for this project.
#[account]
pub struct RwaMetadataGuard {}

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
pub struct InitializeRwaMintByGovernance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must equal config.governance_release_authority (validated in handler).
    pub release_authority: Signer<'info>,

    pub config: Account<'info, project_escrow::Config>,
    pub project: Account<'info, Project>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8 + 8 + 1,
        seeds = [b"rwa_state", project.key().as_ref()],
        bump,
    )]
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        init,
        payer = payer,
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

    /// Receipt mint PDA from project_escrow [b"receipt", project, backer]; validated in instruction.
    pub receipt_mint: InterfaceAccount<'info, Mint>,

    /// Backer's token account for the receipt mint; must hold >= 1. Burned in instruction.
    #[account(
        mut,
        constraint = receipt_token_account.mint == receipt_mint.key(),
        constraint = receipt_token_account.owner == backer.key(),
    )]
    pub receipt_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Project escrow program (validated must equal project_escrow::ID for PDA derivation).
    /// CHECK: Validated in instruction
    pub project_escrow_program: UncheckedAccount<'info>,

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

/// Same as ClaimRwaTokens but without receipt accounts; for backers who funded before on-chain receipts.
#[derive(Accounts)]
pub struct ClaimRwaTokensLegacy<'info> {
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

#[derive(Accounts)]
pub struct InitializeRwaMetadata<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(constraint = rwa_state.authority == authority.key())]
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        mut,
        seeds = [b"rwa_mint", rwa_state.project.as_ref()],
        bump,
    )]
    pub rwa_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA validated by seeds; signs for Metaplex CreateV1
    #[account(seeds = [b"rwa_mint_authority", rwa_state.project.as_ref()], bump)]
    pub rwa_mint_authority: UncheckedAccount<'info>,

    /// One-time guard: init here so second call fails (account already exists).
    #[account(
        init,
        payer = authority,
        space = 8,
        seeds = [b"rwa_metadata", rwa_state.project.as_ref()],
        bump,
    )]
    pub metadata_guard: Account<'info, RwaMetadataGuard>,

    /// Metaplex metadata PDA (['metadata', MPL_TOKEN_METADATA_ID, mint]); validated in handler.
    /// CHECK: Validated against Metadata::find_pda(rwa_mint.key()) in instruction
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// Metaplex Token Metadata program
    /// CHECK: Validated in instruction (must be MPL_TOKEN_METADATA_ID)
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// Sysvar Instructions (required by Metaplex CreateV1)
    /// CHECK: Required by Metaplex
    pub sysvar_instructions: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
