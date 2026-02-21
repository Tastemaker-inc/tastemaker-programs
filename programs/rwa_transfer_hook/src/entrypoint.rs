//! Program entrypoint.

use {
    solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey},
    spl_transfer_hook_interface::instruction::TransferHookInstruction,
};

use crate::processor;

solana_program::entrypoint::entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = TransferHookInstruction::unpack(instruction_data)?;

    match instruction {
        TransferHookInstruction::Execute { amount } => {
            processor::process_execute(program_id, accounts, amount)
        }
        TransferHookInstruction::InitializeExtraAccountMetaList {
            extra_account_metas,
        } => processor::process_initialize_extra_account_meta_list(
            program_id,
            accounts,
            &extra_account_metas,
        ),
        TransferHookInstruction::UpdateExtraAccountMetaList { .. } => {
            // For pass-through we don't support update; could add later
            Err(solana_program::program_error::ProgramError::InvalidInstructionData)
        }
    }
}
