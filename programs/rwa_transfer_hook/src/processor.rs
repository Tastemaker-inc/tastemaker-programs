//! Transfer hook instruction processor.

use {
    solana_account_info::next_account_info,
    solana_cpi::{invoke, invoke_signed},
    solana_msg::msg,
    solana_program_error::ProgramResult,
    solana_pubkey::Pubkey,
    solana_system_interface::instruction as system_instruction,
    spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList},
    spl_token_2022::{extension::StateWithExtensions, state::Mint},
    spl_transfer_hook_interface::{
        collect_extra_account_metas_signer_seeds, get_extra_account_metas_address,
        get_extra_account_metas_address_and_bump_seed,
        instruction::{ExecuteInstruction, TransferHookInstruction},
    },
};

/// Process Execute instruction (pass-through: approve all transfers).
pub fn process_execute(
    program_id: &Pubkey,
    accounts: &[solana_account_info::AccountInfo<'_>],
    amount: u64,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();

    let _source_account_info = next_account_info(account_info_iter)?;
    let mint_info = next_account_info(account_info_iter)?;
    let _destination_account_info = next_account_info(account_info_iter)?;
    let _authority_info = next_account_info(account_info_iter)?;
    let extra_account_metas_info = next_account_info(account_info_iter)?;

    // Validate the extra-account-metas PDA exists and matches
    let expected_validation_address = get_extra_account_metas_address(mint_info.key, program_id);
    if expected_validation_address != *extra_account_metas_info.key {
        return Err(solana_program_error::ProgramError::InvalidSeeds);
    }

    // Verify account infos match the expected layout (empty extra metas for pass-through)
    let data = extra_account_metas_info.try_borrow_data()?;
    ExtraAccountMetaList::check_account_infos::<ExecuteInstruction>(
        accounts,
        &TransferHookInstruction::Execute { amount }.pack(),
        program_id,
        &data,
    )?;

    msg!(
        "RWA transfer hook: pass-through approved (amount: {})",
        amount
    );
    Ok(())
}

/// Process InitializeExtraAccountMetaList with empty extra accounts (pass-through).
///
/// Accounts:
///   0. `[writable]` extra-account-metas PDA
///   1. `[]`          mint
///   2. `[signer]`    mint authority
///   3. `[]`          system program
///   4. `[writable, signer]` payer (funds PDA rent)
pub fn process_initialize_extra_account_meta_list(
    program_id: &Pubkey,
    accounts: &[solana_account_info::AccountInfo<'_>],
    extra_account_metas: &[ExtraAccountMeta],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();

    let extra_account_metas_info = next_account_info(account_info_iter)?;
    let mint_info = next_account_info(account_info_iter)?;
    let authority_info = next_account_info(account_info_iter)?;
    let _system_program_info = next_account_info(account_info_iter)?;
    let payer_info = next_account_info(account_info_iter)?;

    // Validate mint authority (Token2022 mints have base + extensions)
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    let mint_authority: Option<Pubkey> = mint.base.mint_authority.into();
    let mint_authority =
        mint_authority.ok_or(solana_program_error::ProgramError::InvalidAccountData)?;

    if !authority_info.is_signer {
        return Err(solana_program_error::ProgramError::MissingRequiredSignature);
    }
    if *authority_info.key != mint_authority {
        return Err(solana_program_error::ProgramError::InvalidAccountData);
    }

    let (expected_validation_address, bump_seed) =
        get_extra_account_metas_address_and_bump_seed(mint_info.key, program_id);
    if expected_validation_address != *extra_account_metas_info.key {
        return Err(solana_program_error::ProgramError::InvalidSeeds);
    }

    let bump_seed = [bump_seed];
    let signer_seeds = collect_extra_account_metas_signer_seeds(mint_info.key, &bump_seed);
    let length = extra_account_metas.len();
    let account_size = ExtraAccountMetaList::size_of(length)?;

    // Fund PDA so it survives rent collection after allocate+assign.
    use solana_program::sysvar::{rent::Rent, Sysvar as _};
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(account_size);
    invoke(
        &system_instruction::transfer(payer_info.key, extra_account_metas_info.key, lamports),
        &[payer_info.clone(), extra_account_metas_info.clone()],
    )?;

    invoke_signed(
        &system_instruction::allocate(extra_account_metas_info.key, account_size as u64),
        core::slice::from_ref(extra_account_metas_info),
        &[&signer_seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(extra_account_metas_info.key, program_id),
        core::slice::from_ref(extra_account_metas_info),
        &[&signer_seeds],
    )?;

    let mut data = extra_account_metas_info.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, extra_account_metas)?;

    msg!("RWA transfer hook: extra-account-metas initialized (empty, pass-through)");
    Ok(())
}
