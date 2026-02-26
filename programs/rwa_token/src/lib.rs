//! TasteMaker per-project RWA token. Mint on project completion; backers claim (pull).

#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Burn, Mint, MintTo, TokenAccount, TokenInterface};
use spl_token_2022::{
    extension::{transfer_hook::instruction as transfer_hook_instruction, ExtensionType},
    instruction as token_instruction,
    state::Mint as SplMint,
};
use spl_transfer_hook_interface::{
    get_extra_account_metas_address,
    instruction::initialize_extra_account_meta_list as create_init_extra_meta_ix,
};

/// Token-2022 program ID (required for TransferHook mints).
pub static TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Upgradeable loader: Program variant.
const UPGRADEABLE_LOADER_PROGRAM_STATE: u8 = 2;
/// Upgradeable loader: ProgramData variant.
const UPGRADEABLE_LOADER_PROGRAM_DATA_STATE: u8 = 3;
/// Program account min length: 4-byte discriminant + 32-byte programdata address (spec).
const MIN_PROGRAM_ACCOUNT_LEN: usize = 36;
/// ProgramData metadata min length: 4-byte + 8 + 1 + 32 (spec).
const MIN_PROGRAMDATA_METADATA_LEN: usize = 45;

/// Validates that the signer is the program's upgrade authority by reading upgradeable loader state.
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
        RwaError::NotUpgradeAuthority
    );
    require!(
        program_account_data.len() >= MIN_PROGRAM_ACCOUNT_LEN
            && u32::from_le_bytes(program_account_data[0..4].try_into().unwrap())
                == UPGRADEABLE_LOADER_PROGRAM_STATE as u32,
        RwaError::NotUpgradeAuthority
    );
    let programdata_address =
        Pubkey::new_from_array(program_account_data[4..36].try_into().unwrap());
    require!(
        program_data_account_key == &programdata_address,
        RwaError::NotUpgradeAuthority
    );
    require!(
        program_data_account_data.len() >= MIN_PROGRAMDATA_METADATA_LEN
            && u32::from_le_bytes(program_data_account_data[0..4].try_into().unwrap())
                == UPGRADEABLE_LOADER_PROGRAM_DATA_STATE as u32,
        RwaError::NotUpgradeAuthority
    );
    let option_byte = program_data_account_data[12];
    require!(option_byte == 1, RwaError::NotUpgradeAuthority); // Option::Some
    let upgrade_authority =
        Pubkey::new_from_array(program_data_account_data[13..45].try_into().unwrap());
    require!(
        upgrade_authority == *authority_key,
        RwaError::NotUpgradeAuthority
    );
    Ok(())
}

/// Creates a Token-2022 mint with TransferHook extension at the given PDA, then initializes
/// the transfer hook's extra-account-metas (empty list for pass-through).
#[allow(clippy::too_many_arguments)]
fn create_rwa_mint_with_transfer_hook<'info>(
    payer: &AccountInfo<'info>,
    rwa_mint: &AccountInfo<'info>,
    rwa_mint_authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    transfer_hook_program_id: Pubkey,
    transfer_hook_program: &AccountInfo<'info>,
    extra_account_metas: &AccountInfo<'info>,
    project_key: Pubkey,
    program_id: &Pubkey,
) -> Result<()> {
    let mint_len =
        ExtensionType::try_calculate_account_len::<SplMint>(&[ExtensionType::TransferHook])
            .map_err(|_| ProgramError::InvalidAccountData)?;
    let lamports = Rent::get()?.minimum_balance(mint_len);

    let (_, mint_bump) =
        Pubkey::find_program_address(&[b"rwa_mint", project_key.as_ref()], program_id);
    let mint_seeds: &[&[u8]] = &[b"rwa_mint", project_key.as_ref(), &[mint_bump]];
    let mint_signer_seeds: &[&[&[u8]]] = &[mint_seeds];

    let (_, auth_bump) =
        Pubkey::find_program_address(&[b"rwa_mint_authority", project_key.as_ref()], program_id);
    let auth_seeds: &[&[u8]] = &[b"rwa_mint_authority", project_key.as_ref(), &[auth_bump]];
    let auth_signer_seeds: &[&[&[u8]]] = &[auth_seeds];

    // 1. Create mint account (owner = Token-2022). rwa_mint is a PDA; must use invoke_signed.
    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            payer.key,
            rwa_mint.key,
            lamports,
            mint_len as u64,
            &TOKEN_2022_PROGRAM_ID,
        ),
        &[payer.clone(), rwa_mint.clone(), system_program.clone()],
        mint_signer_seeds,
    )?;

    // 2. Initialize TransferHook extension (before InitializeMint)
    let init_hook_ix = transfer_hook_instruction::initialize(
        &TOKEN_2022_PROGRAM_ID,
        rwa_mint.key,
        Some(*rwa_mint_authority.key),
        Some(transfer_hook_program_id),
    )?;
    anchor_lang::solana_program::program::invoke_signed(
        &init_hook_ix,
        &[rwa_mint.clone(), token_program.clone()],
        auth_signer_seeds,
    )?;

    // 3. Initialize mint (decimals=6, mint_authority=rwa_mint_authority, freeze_authority=None)
    let init_mint_ix = token_instruction::initialize_mint2(
        &TOKEN_2022_PROGRAM_ID,
        rwa_mint.key,
        rwa_mint_authority.key,
        None,
        6,
    )?;
    anchor_lang::solana_program::program::invoke_signed(
        &init_mint_ix,
        &[rwa_mint.clone(), token_program.clone()],
        auth_signer_seeds,
    )?;

    // 4. Initialize extra-account-metas (empty = pass-through) on rwa_transfer_hook.
    //    The hook's processor expects a 5th account (payer) to fund the PDA for rent exemption.
    let extra_meta_pda = get_extra_account_metas_address(rwa_mint.key, &transfer_hook_program_id);
    require!(
        extra_account_metas.key() == extra_meta_pda,
        RwaError::InvalidExtraAccountMetas
    );
    let mut init_extra_ix = create_init_extra_meta_ix(
        &transfer_hook_program_id,
        &extra_meta_pda,
        rwa_mint.key,
        rwa_mint_authority.key,
        &[],
    );
    init_extra_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new(
            *payer.key, true,
        ));
    anchor_lang::solana_program::program::invoke_signed(
        &init_extra_ix,
        &[
            transfer_hook_program.clone(),
            extra_account_metas.clone(),
            rwa_mint.clone(),
            rwa_mint_authority.clone(),
            system_program.clone(),
            payer.clone(),
        ],
        auth_signer_seeds,
    )?;

    Ok(())
}

use mpl_token_metadata::{
    accounts::Metadata, instructions::CreateV1CpiBuilder, types::TokenStandard,
    ID as MPL_TOKEN_METADATA_ID,
};
use project_escrow::{Backer, Project, ProjectStatus};

// Anchor programs must be deployed at their declared ID.
// We support devnet vs localnet IDs via a build-time feature so CI/local tests keep working.
// Localnet first so `anchor keys sync` updates it to match target/deploy keypairs; build (no devnet) then uses keypair ID.
#[cfg(not(feature = "devnet"))]
declare_id!("8PTbAHnemqCN8gnvMqkUfa3SUkHAR7zFcLQsxryq7BoS");
#[cfg(feature = "devnet")]
declare_id!("GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE");

/// Max lengths for RWA metadata (aligned with Metaplex Token Metadata).
const MAX_NAME_LEN: usize = 32;
const MAX_SYMBOL_LEN: usize = 10;
const MAX_URI_LEN: usize = 200;

/// Suffix added to project name for RWA metadata: " Share" (6 bytes).
const RWA_NAME_SUFFIX: &str = " Share";
/// Max length for the project-name part so that (project_part + RWA_NAME_SUFFIX).len() <= MAX_NAME_LEN.
const MAX_PROJECT_NAME_PART_LEN: usize = MAX_NAME_LEN - RWA_NAME_SUFFIX.len();

/// Truncates `s` to at most `max_bytes` at a UTF-8 character boundary.
fn truncate_to_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut len = max_bytes;
    while len > 0 && !s.is_char_boundary(len) {
        len -= 1;
    }
    &s[..len]
}

/// Base URL for RWA metadata API (used by initialize_rwa_metadata_by_governance).
const RWA_METADATA_BASE_URL: &str = "https://tastemaker.music";

/// Max lengths for RwaRights string fields.
const MAX_TERMS_URI_LEN: usize = 200;
const MAX_JURISDICTION_LEN: usize = 50;

#[program]
pub mod rwa_token {
    use super::*;

    /// One-time init: store the transfer hook program ID. Only the program upgrade authority can call this.
    pub fn initialize_rwa_config(
        ctx: Context<InitializeRwaConfig>,
        transfer_hook_program_id: Pubkey,
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

        let config = &mut ctx.accounts.rwa_config;
        config.transfer_hook_program_id = transfer_hook_program_id;
        msg!(
            "RwaConfig initialized: transfer_hook_program_id = {}",
            config.transfer_hook_program_id
        );
        Ok(())
    }

    pub fn initialize_rwa_mint(ctx: Context<InitializeRwaMint>, total_supply: u64) -> Result<()> {
        require!(
            ctx.accounts.project.status == ProjectStatus::Completed,
            RwaError::ProjectNotCompleted
        );
        require!(
            ctx.accounts.token_program.key() == TOKEN_2022_PROGRAM_ID,
            RwaError::InvalidTokenProgram
        );
        let (expected_mint, _) = Pubkey::find_program_address(
            &[b"rwa_mint", ctx.accounts.project.key().as_ref()],
            ctx.program_id,
        );
        require!(
            ctx.accounts.rwa_mint.key() == expected_mint,
            RwaError::InvalidMintPda
        );
        require!(
            ctx.accounts.rwa_transfer_hook_program.key()
                == ctx.accounts.rwa_config.transfer_hook_program_id,
            RwaError::InvalidTransferHookProgram
        );

        let state = &mut ctx.accounts.rwa_state;
        state.project = ctx.accounts.project.key();
        state.authority = ctx.accounts.authority.key();
        state.total_supply = total_supply;
        state.minted = 0;
        state.mint_frozen = false;

        create_rwa_mint_with_transfer_hook(
            &ctx.accounts.authority.to_account_info(),
            &ctx.accounts.rwa_mint.to_account_info(),
            &ctx.accounts.rwa_mint_authority.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rwa_config.transfer_hook_program_id,
            &ctx.accounts.rwa_transfer_hook_program.to_account_info(),
            &ctx.accounts.extra_account_metas.to_account_info(),
            state.project,
            ctx.program_id,
        )?;

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
        require!(
            ctx.accounts.token_program.key() == TOKEN_2022_PROGRAM_ID,
            RwaError::InvalidTokenProgram
        );
        let (expected_mint, _) = Pubkey::find_program_address(
            &[b"rwa_mint", ctx.accounts.project.key().as_ref()],
            ctx.program_id,
        );
        require!(
            ctx.accounts.rwa_mint.key() == expected_mint,
            RwaError::InvalidMintPda
        );
        require!(
            ctx.accounts.rwa_transfer_hook_program.key()
                == ctx.accounts.rwa_config.transfer_hook_program_id,
            RwaError::InvalidTransferHookProgram
        );

        let state = &mut ctx.accounts.rwa_state;
        state.project = ctx.accounts.project.key();
        state.authority = ctx.accounts.project.artist;
        state.total_supply = total_supply;
        state.minted = 0;
        state.mint_frozen = false;

        create_rwa_mint_with_transfer_hook(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.rwa_mint.to_account_info(),
            &ctx.accounts.rwa_mint_authority.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rwa_config.transfer_hook_program_id,
            &ctx.accounts.rwa_transfer_hook_program.to_account_info(),
            &ctx.accounts.extra_account_metas.to_account_info(),
            state.project,
            ctx.program_id,
        )?;

        msg!(
            "RWA mint initialized by governance for project {}",
            state.project
        );
        Ok(())
    }

    /// One-time init of on-chain rights specification. Callable by rwa_state.authority after RWA mint exists.
    pub fn initialize_rwa_rights(
        ctx: Context<InitializeRwaRights>,
        rights_type: RightsType,
        revenue_split_bps: u16,
        artist_split_bps: u16,
        duration_secs: i64,
        effective_from: i64,
        terms_hash: [u8; 32],
        terms_uri: String,
        jurisdiction: String,
    ) -> Result<()> {
        let state = &ctx.accounts.rwa_state;
        require!(
            ctx.accounts.authority.key() == state.authority,
            RwaError::NotAuthority
        );
        require!(
            revenue_split_bps.saturating_add(artist_split_bps) <= 10_000,
            RwaError::InvalidSplit
        );
        require!(
            terms_uri.len() <= MAX_TERMS_URI_LEN,
            RwaError::TermsUriTooLong
        );
        require!(
            jurisdiction.len() <= MAX_JURISDICTION_LEN,
            RwaError::JurisdictionTooLong
        );

        let rights = &mut ctx.accounts.rwa_rights;
        rights.project = state.project;
        rights.rights_type = rights_type;
        rights.revenue_split_bps = revenue_split_bps;
        rights.artist_split_bps = artist_split_bps;
        rights.duration_secs = duration_secs;
        rights.effective_from = effective_from;
        rights.terms_hash = terms_hash;
        rights.terms_uri = terms_uri;
        rights.jurisdiction = jurisdiction;

        msg!("RwaRights initialized for project {}", rights.project);
        Ok(())
    }

    /// Update terms_hash and terms_uri (e.g. after a material-edit governance pass). Callable by rwa_state.authority.
    pub fn update_rwa_rights(
        ctx: Context<UpdateRwaRights>,
        new_terms_hash: [u8; 32],
        new_terms_uri: String,
    ) -> Result<()> {
        let state = &ctx.accounts.rwa_state;
        require!(
            ctx.accounts.authority.key() == state.authority,
            RwaError::NotAuthority
        );
        require!(
            new_terms_uri.len() <= MAX_TERMS_URI_LEN,
            RwaError::TermsUriTooLong
        );
        let rights = &mut ctx.accounts.rwa_rights;
        rights.terms_hash = new_terms_hash;
        rights.terms_uri = new_terms_uri;
        msg!("RwaRights updated for project {}", rights.project);
        Ok(())
    }

    /// One-time init of RwaRights by governance (last-milestone finalize). Callable only by config.governance_release_authority.
    pub fn initialize_rwa_rights_by_governance(
        ctx: Context<InitializeRwaRightsByGovernance>,
        rights_type: RightsType,
        revenue_split_bps: u16,
        artist_split_bps: u16,
        duration_secs: i64,
        effective_from: i64,
        terms_hash: [u8; 32],
        terms_uri: String,
        jurisdiction: String,
    ) -> Result<()> {
        require!(
            ctx.accounts.release_authority.key() == ctx.accounts.config.governance_release_authority,
            RwaError::NotReleaseAuthority
        );
        require!(
            revenue_split_bps.saturating_add(artist_split_bps) <= 10_000,
            RwaError::InvalidSplit
        );
        require!(
            terms_uri.len() <= MAX_TERMS_URI_LEN,
            RwaError::TermsUriTooLong
        );
        require!(
            jurisdiction.len() <= MAX_JURISDICTION_LEN,
            RwaError::JurisdictionTooLong
        );

        let rights = &mut ctx.accounts.rwa_rights;
        rights.project = ctx.accounts.rwa_state.project;
        rights.rights_type = rights_type;
        rights.revenue_split_bps = revenue_split_bps;
        rights.artist_split_bps = artist_split_bps;
        rights.duration_secs = duration_secs;
        rights.effective_from = effective_from;
        rights.terms_hash = terms_hash;
        rights.terms_uri = terms_uri;
        rights.jurisdiction = jurisdiction;

        msg!(
            "RwaRights initialized by governance for project {}",
            rights.project
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

    /// Called by governance when the last milestone is released, after initialize_rwa_mint_by_governance.
    /// Creates Metaplex metadata so wallets can display name, symbol, and image.
    /// Only the config's governance_release_authority may call this.
    pub fn initialize_rwa_metadata_by_governance(
        ctx: Context<InitializeRwaMetadataByGovernance>,
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
        let state = &ctx.accounts.rwa_state;
        // update_authority == rwa_state.authority is enforced by the account constraint.

        let (metadata_pda, _) = Metadata::find_pda(&ctx.accounts.rwa_mint.key());
        require!(
            ctx.accounts.metadata.key() == metadata_pda,
            RwaError::InvalidMetadataAccount
        );
        require!(
            ctx.accounts.token_metadata_program.key() == MPL_TOKEN_METADATA_ID,
            RwaError::InvalidTokenMetadataProgram
        );

        let project = &ctx.accounts.project;
        let name = if project.name.trim().is_empty() {
            "Ownership Share".to_string()
        } else {
            let part = truncate_to_char_boundary(project.name.trim(), MAX_PROJECT_NAME_PART_LEN);
            format!("{}{}", part, RWA_NAME_SUFFIX)
        };
        require!(name.len() <= MAX_NAME_LEN, RwaError::MetadataNameTooLong);
        let symbol = "RWA".to_string();
        let uri = format!(
            "{}/api/rwa-metadata?project={}",
            RWA_METADATA_BASE_URL, state.project
        );
        require!(uri.len() <= MAX_URI_LEN, RwaError::MetadataUriTooLong);

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
            .payer(ctx.accounts.payer.as_ref())
            .update_authority(ctx.accounts.update_authority.as_ref(), true)
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

        msg!(
            "RWA metadata initialized by governance for mint {}",
            ctx.accounts.rwa_mint.key()
        );
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
    #[msg("Revenue split + artist split must not exceed 10000 bps")]
    InvalidSplit,
    #[msg("Terms URI too long")]
    TermsUriTooLong,
    #[msg("Jurisdiction string too long")]
    JurisdictionTooLong,
    #[msg("Only program upgrade authority can initialize RwaConfig")]
    NotUpgradeAuthority,
    #[msg("Extra account metas PDA does not match expected address")]
    InvalidExtraAccountMetas,
    #[msg("Token program must be Token-2022 for TransferHook mints")]
    InvalidTokenProgram,
    #[msg("RWA mint account does not match expected PDA")]
    InvalidMintPda,
    #[msg("Transfer hook program does not match RwaConfig")]
    InvalidTransferHookProgram,
}

#[account]
pub struct RwaConfig {
    pub transfer_hook_program_id: Pubkey,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RightsType {
    MasterRecording,
    MechanicalRoyalties,
    ProfitShare,
    TourRevenue,
    MerchRevenue,
    Custom,
}

#[account]
pub struct RwaRights {
    pub project: Pubkey,
    pub rights_type: RightsType,
    pub revenue_split_bps: u16,
    pub artist_split_bps: u16,
    pub duration_secs: i64,
    pub effective_from: i64,
    pub terms_hash: [u8; 32],
    pub terms_uri: String,
    pub jurisdiction: String,
}

#[derive(Accounts)]
pub struct InitializeRwaConfig<'info> {
    /// Must be the program upgrade authority (validated in instruction).
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + 32,
        seeds = [b"rwa_config"],
        bump,
    )]
    pub rwa_config: Account<'info, RwaConfig>,

    /// Program account (executable) for this program. Used to read programdata address.
    /// CHECK: validated in instruction (must equal ctx.program_id)
    pub program_account: UncheckedAccount<'info>,

    /// ProgramData account for this program. Used to read upgrade_authority_address.
    /// CHECK: validated in instruction (must match program_account's programdata_address)
    pub program_data_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeRwaRights<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"rwa_state", rwa_state.project.as_ref()],
        bump,
    )]
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 2 + 2 + 8 + 8 + 32 + 4 + MAX_TERMS_URI_LEN + 4 + MAX_JURISDICTION_LEN,
        seeds = [b"rwa_rights", rwa_state.project.as_ref()],
        bump,
    )]
    pub rwa_rights: Account<'info, RwaRights>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeRwaRightsByGovernance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must equal config.governance_release_authority (validated in instruction).
    pub release_authority: Signer<'info>,

    pub config: Account<'info, project_escrow::Config>,
    pub project: Account<'info, Project>,

    #[account(
        constraint = rwa_state.project == project.key(),
        seeds = [b"rwa_state", project.key().as_ref()],
        bump,
    )]
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 1 + 2 + 2 + 8 + 8 + 32 + 4 + MAX_TERMS_URI_LEN + 4 + MAX_JURISDICTION_LEN,
        seeds = [b"rwa_rights", project.key().as_ref()],
        bump,
    )]
    pub rwa_rights: Account<'info, RwaRights>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRwaRights<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"rwa_state", rwa_state.project.as_ref()],
        bump,
    )]
    pub rwa_state: Account<'info, RwaState>,

    #[account(
        mut,
        seeds = [b"rwa_rights", rwa_state.project.as_ref()],
        bump,
    )]
    pub rwa_rights: Account<'info, RwaRights>,
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
        seeds = [b"rwa_config"],
        bump,
    )]
    pub rwa_config: Account<'info, RwaConfig>,

    /// Created manually with TransferHook extension; address validated in handler.
    /// CHECK: Validated in instruction (must be rwa_mint PDA)
    #[account(mut)]
    pub rwa_mint: UncheckedAccount<'info>,

    /// CHECK: PDA validated by seeds
    #[account(seeds = [b"rwa_mint_authority", project.key().as_ref()], bump)]
    pub rwa_mint_authority: UncheckedAccount<'info>,

    /// rwa_transfer_hook program (for InitializeExtraAccountMetaList CPI)
    /// CHECK: Validated via rwa_config.transfer_hook_program_id
    pub rwa_transfer_hook_program: UncheckedAccount<'info>,

    /// Extra-account-metas PDA [b"extra-account-metas", rwa_mint]; validated in handler.
    /// CHECK: Validated in instruction
    #[account(mut)]
    pub extra_account_metas: UncheckedAccount<'info>,

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
        seeds = [b"rwa_config"],
        bump,
    )]
    pub rwa_config: Account<'info, RwaConfig>,

    /// Created manually with TransferHook extension; address validated in handler.
    /// CHECK: Validated in instruction (must be rwa_mint PDA)
    #[account(mut)]
    pub rwa_mint: UncheckedAccount<'info>,

    /// CHECK: PDA validated by seeds
    #[account(seeds = [b"rwa_mint_authority", project.key().as_ref()], bump)]
    pub rwa_mint_authority: UncheckedAccount<'info>,

    /// rwa_transfer_hook program (for InitializeExtraAccountMetaList CPI)
    /// CHECK: Validated via rwa_config.transfer_hook_program_id
    pub rwa_transfer_hook_program: UncheckedAccount<'info>,

    /// Extra-account-metas PDA [b"extra-account-metas", rwa_mint]; validated in handler.
    /// CHECK: Validated in instruction
    #[account(mut)]
    pub extra_account_metas: UncheckedAccount<'info>,

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

    /// Receipt mint PDA from project_escrow [b"receipt", project, backer]; validated in instruction. Mut for burn (supply decrement).
    #[account(mut)]
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

#[derive(Accounts)]
pub struct InitializeRwaMetadataByGovernance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Must equal config.governance_release_authority (validated in handler).
    pub release_authority: Signer<'info>,

    pub config: Account<'info, project_escrow::Config>,
    pub project: Account<'info, Project>,

    #[account(constraint = rwa_state.authority == project.artist)]
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
        payer = payer,
        space = 8,
        seeds = [b"rwa_metadata", rwa_state.project.as_ref()],
        bump,
    )]
    pub metadata_guard: Account<'info, RwaMetadataGuard>,

    /// Metaplex metadata PDA (['metadata', MPL_TOKEN_METADATA_ID, mint]); validated in handler.
    /// CHECK: Validated against Metadata::find_pda(rwa_mint.key()) in instruction
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// Artist wallet (rwa_state.authority); used as Metaplex update_authority.
    /// Must be Signer so the CPI account meta propagates is_signer=true through
    /// the governance -> rwa_token -> Metaplex CPI chain (Anchor CPI codegen
    /// hardcodes is_signer from the type, ignoring AccountInfo.is_signer).
    #[account(constraint = update_authority.key() == rwa_state.authority @ RwaError::NotAuthority)]
    pub update_authority: Signer<'info>,

    /// Metaplex Token Metadata program
    /// CHECK: Validated in instruction (must be MPL_TOKEN_METADATA_ID)
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// Sysvar Instructions (required by Metaplex CreateV1)
    /// CHECK: Required by Metaplex
    pub sysvar_instructions: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Split validation: revenue_split_bps + artist_split_bps must be <= 10_000 (100%).
    #[test]
    fn test_rwa_rights_split_bounds() {
        // Valid: 70% backer + 30% artist
        assert!(7000u16.saturating_add(3000) <= 10_000);
        // Valid: 100% artist
        assert!(0u16.saturating_add(10_000) <= 10_000);
        // Invalid: over 100%
        assert!(7000u16.saturating_add(3001) > 10_000);
        assert!(10_001u16.saturating_add(0) > 10_000);
    }

    #[test]
    fn test_rwa_rights_string_limits() {
        const _: () = assert!(MAX_TERMS_URI_LEN == 200);
        const _: () = assert!(MAX_JURISDICTION_LEN == 50);
    }
}
