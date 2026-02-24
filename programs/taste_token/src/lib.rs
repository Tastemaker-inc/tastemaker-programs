//! TasteMaker $TASTE platform token.
//! Token-2022 compatible (use token_2022 program when deploying). 9 decimals.
//! Max supply 1B $TASTE (whitepaper). Mint authority can be revoked after TGE.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, MintTo, SetAuthority, TokenAccount, TokenInterface};

// Anchor programs must be deployed at their declared ID.
// We support devnet vs localnet IDs via a build-time feature so CI/local tests keep working.
// Localnet first so `anchor keys sync` updates it to match target/deploy keypairs; build (no devnet) then uses keypair ID.
#[cfg(not(feature = "devnet"))]
declare_id!("CEwawQsr27EFM9en9JDiuaVLVgb69ePK9T441DcUSPkE");
#[cfg(feature = "devnet")]
declare_id!("2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo");

const DECIMALS: u8 = 9;
pub const MAX_SUPPLY: u64 = 1_000_000_000 * (10u64).pow(DECIMALS as u32);

#[error_code]
pub enum TasteError {
    #[msg("Mint would exceed max supply")]
    ExceedsMaxSupply,
    #[msg("Signer is not the mint authority")]
    InvalidMintAuthority,
}

#[program]
pub mod taste_token {
    use super::*;

    pub fn initialize_mint(ctx: Context<InitializeMint>) -> Result<()> {
        msg!("$TASTE mint initialized: {}", ctx.accounts.mint.key());
        Ok(())
    }

    pub fn mint_to_treasury(ctx: Context<MintToTreasury>, amount: u64) -> Result<()> {
        let supply = ctx.accounts.mint.supply;
        require!(
            supply
                .checked_add(amount)
                .ok_or(TasteError::ExceedsMaxSupply)?
                <= MAX_SUPPLY,
            TasteError::ExceedsMaxSupply
        );
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        anchor_spl::token_interface::mint_to(cpi_ctx, amount)?;
        msg!("Minted {} $TASTE to treasury", amount);
        Ok(())
    }

    pub fn mint_to(ctx: Context<MintToRecipient>, amount: u64) -> Result<()> {
        let supply = ctx.accounts.mint.supply;
        require!(
            supply
                .checked_add(amount)
                .ok_or(TasteError::ExceedsMaxSupply)?
                <= MAX_SUPPLY,
            TasteError::ExceedsMaxSupply
        );
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.recipient.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        anchor_spl::token_interface::mint_to(cpi_ctx, amount)?;
        msg!("Minted {} $TASTE to recipient", amount);
        Ok(())
    }

    pub fn burn(ctx: Context<Burn>, amount: u64) -> Result<()> {
        anchor_spl::token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.source.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        msg!("Burned {} $TASTE", amount);
        Ok(())
    }

    pub fn freeze_mint_authority(ctx: Context<FreezeMintAuthority>) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.mint_authority.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
        );
        anchor_spl::token_interface::set_authority(
            cpi_ctx,
            anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType::MintTokens,
            None,
        )?;
        msg!("Mint authority revoked for $TASTE mint");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub mint_authority: Signer<'info>,

    #[account(
        init,
        payer = mint_authority,
        mint::decimals = DECIMALS,
        mint::authority = mint_authority.key(),
        mint::freeze_authority = mint_authority.key(),
        seeds = [b"taste_mint"],
        bump,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: PDA validated by seeds
    #[account(seeds = [b"treasury"], bump)]
    pub treasury_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = mint_authority,
        associated_token::mint = mint,
        associated_token::authority = treasury_authority,
        associated_token::token_program = token_program,
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintToTreasury<'info> {
    pub mint_authority: Signer<'info>,

    #[account(
        mut,
        constraint = mint.mint_authority == Some(mint_authority.key()).into() @ TasteError::InvalidMintAuthority
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct MintToRecipient<'info> {
    pub mint_authority: Signer<'info>,

    #[account(
        mut,
        constraint = mint.mint_authority == Some(mint_authority.key()).into() @ TasteError::InvalidMintAuthority
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub recipient: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FreezeMintAuthority<'info> {
    pub mint_authority: Signer<'info>,

    #[account(
        mut,
        constraint = mint.mint_authority == Some(mint_authority.key()).into() @ TasteError::InvalidMintAuthority
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Burn<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub source: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_max_supply_constant() {
        assert_eq!(MAX_SUPPLY, 1_000_000_000 * (10u64).pow(DECIMALS as u32));
    }

    #[test]
    fn test_supply_cap_boundary() {
        // supply + amount <= MAX_SUPPLY: at boundary, (MAX_SUPPLY - 1) + 1 is ok, (MAX_SUPPLY - 1) + 2 is not
        let supply = MAX_SUPPLY - 1;
        let amount1 = 1u64;
        let amount2 = 2u64;
        assert!(supply.checked_add(amount1).unwrap() <= MAX_SUPPLY);
        assert!(supply.checked_add(amount2).unwrap() > MAX_SUPPLY);
    }
}
