//! TasteMaker OTC marketplace: on-chain offers for IOU receipt NFTs and RWA tokens.
//! Token-2022 only for asset and quote mint. No LP or curve; create/cancel/accept offer.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("DDLUuH5nqKJfBCEibEjRgbFYXGSHUH8ovFeGWNNJTzcj");

/// SPL Token-2022 program ID. Marketplace accepts only Token-2022 assets and quote.
pub static TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[program]
pub mod otc_market {
    use super::*;

    /// Placeholder: no-op init for deploy. Use create_offer / cancel_offer / accept_offer.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Create an offer (sell or buy). Token-2022 only for asset mint and quote mint.
    pub fn create_offer(
        ctx: Context<CreateOffer>,
        amount: u64,
        price: u64,
        offer_type: OfferType,
        expiry_slot: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.asset_token_program.key() == TOKEN_2022_PROGRAM_ID,
            OtcError::NotToken2022
        );
        require!(amount > 0, OtcError::InvalidAmount);
        require!(price > 0, OtcError::InvalidPrice);

        let maker_state = &mut ctx.accounts.maker_state;
        let nonce = maker_state.nonce;
        maker_state.nonce = nonce.checked_add(1).ok_or(OtcError::Overflow)?;

        let offer = &mut ctx.accounts.offer;
        offer.maker = ctx.accounts.maker.key();
        offer.mint = ctx.accounts.asset_mint.key();
        offer.amount = amount;
        offer.price = price;
        offer.offer_type = offer_type;
        offer.status = OfferStatus::Open;
        offer.expiry_slot = expiry_slot;
        offer.bump = ctx.bumps.offer;
        offer.nonce = nonce;
        let offer_type_str = match offer_type {
            OfferType::Sell => "sell",
            OfferType::Buy => "buy",
        };
        msg!(
            "Create offer: maker {} mint {} amount {} price {} {}",
            ctx.accounts.maker.key(),
            ctx.accounts.asset_mint.key(),
            amount,
            price,
            offer_type_str
        );
        Ok(())
    }

    /// Cancel an open offer. Only the maker can cancel.
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        let offer = &mut ctx.accounts.offer;
        require!(
            matches!(offer.status, OfferStatus::Open),
            OtcError::OfferNotOpen
        );
        require!(ctx.accounts.maker.key() == offer.maker, OtcError::NotMaker);
        offer.status = OfferStatus::Cancelled;
        msg!("Offer cancelled: {}", ctx.accounts.offer.key());
        Ok(())
    }

    /// Accept an open offer: transfer asset and $TASTE between taker and maker.
    /// For Sell: maker gives asset, taker gives $TASTE. For Buy: maker gives $TASTE, taker gives asset.
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        ctx.accounts.validate_token_2022()?;
        let offer = &ctx.accounts.offer;
        require!(
            matches!(offer.status, OfferStatus::Open),
            OtcError::OfferNotOpen
        );
        require!(
            ctx.accounts.taker.key() != offer.maker,
            OtcError::TakerIsMaker
        );

        let clock = Clock::get()?;
        require!(clock.slot <= offer.expiry_slot, OtcError::OfferExpired);

        let asset_mint = &ctx.accounts.asset_mint;
        let asset_decimals = asset_mint.decimals;
        let taste_decimals = ctx.accounts.quote_mint.decimals;

        let offer = &mut ctx.accounts.offer;
        offer.status = OfferStatus::Taken;

        match offer.offer_type {
            OfferType::Sell => {
                // Maker sends asset to taker; taker sends $TASTE to maker.
                let maker_asset_ata = &ctx.accounts.maker_asset_ata;
                let taker_asset_ata = &ctx.accounts.taker_asset_ata;
                let taker_quote_ata = &ctx.accounts.taker_quote_ata;
                let maker_quote_ata = &ctx.accounts.maker_quote_ata;

                let transfer_asset = TransferChecked {
                    from: maker_asset_ata.to_account_info(),
                    mint: asset_mint.to_account_info(),
                    to: taker_asset_ata.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                };
                let cpi_asset = CpiContext::new(
                    ctx.accounts.asset_token_program.to_account_info(),
                    transfer_asset,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_asset,
                    offer.amount,
                    asset_decimals,
                )?;

                let transfer_quote = TransferChecked {
                    from: taker_quote_ata.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: maker_quote_ata.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                };
                let cpi_quote = CpiContext::new(
                    ctx.accounts.quote_token_program.to_account_info(),
                    transfer_quote,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_quote,
                    offer.price,
                    taste_decimals,
                )?;
            }
            OfferType::Buy => {
                // Taker sends asset to maker; maker sends $TASTE to taker.
                let taker_asset_ata = &ctx.accounts.taker_asset_ata;
                let maker_asset_ata = &ctx.accounts.maker_asset_ata;
                let maker_quote_ata = &ctx.accounts.maker_quote_ata;
                let taker_quote_ata = &ctx.accounts.taker_quote_ata;

                let transfer_asset = TransferChecked {
                    from: taker_asset_ata.to_account_info(),
                    mint: asset_mint.to_account_info(),
                    to: maker_asset_ata.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                };
                let cpi_asset = CpiContext::new(
                    ctx.accounts.asset_token_program.to_account_info(),
                    transfer_asset,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_asset,
                    offer.amount,
                    asset_decimals,
                )?;

                let transfer_quote = TransferChecked {
                    from: maker_quote_ata.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: taker_quote_ata.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                };
                let cpi_quote = CpiContext::new(
                    ctx.accounts.quote_token_program.to_account_info(),
                    transfer_quote,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_quote,
                    offer.price,
                    taste_decimals,
                )?;
            }
        }
        msg!(
            "Offer accepted: {} tokens for {} lamports",
            offer.amount,
            offer.price
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum OfferType {
    Sell,
    Buy,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum OfferStatus {
    Open,
    Taken,
    Cancelled,
}

#[account]
pub struct MakerState {
    pub nonce: u64,
}

#[account]
pub struct Offer {
    pub maker: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub price: u64,
    pub offer_type: OfferType,
    pub status: OfferStatus,
    pub expiry_slot: u64,
    pub bump: u8,
    /// Nonce used in PDA seeds (maker_state.nonce at create time).
    pub nonce: u64,
}

#[error_code]
pub enum OtcError {
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Price must be positive")]
    InvalidPrice,
    #[msg("Offer is not open")]
    OfferNotOpen,
    #[msg("Only the maker can cancel")]
    NotMaker,
    #[msg("Taker cannot be the maker")]
    TakerIsMaker,
    #[msg("Offer has expired")]
    OfferExpired,
    #[msg("Token program must be Token-2022")]
    NotToken2022,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[derive(Accounts)]
#[instruction(amount: u64, price: u64, offer_type: OfferType, expiry_slot: u64)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        init_if_needed,
        payer = maker,
        space = 8 + 8,
        seeds = [b"maker", maker.key().as_ref()],
        bump,
    )]
    pub maker_state: Account<'info, MakerState>,

    #[account(
        init,
        payer = maker,
        space = 8 + 32 + 32 + 8 + 8 + 1 + 1 + 8 + 1 + 8,
        seeds = [b"offer", maker.key().as_ref(), maker_state.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub offer: Account<'info, Offer>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// Token program for the asset mint. Must be Token-2022.
    pub asset_token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"offer", offer.maker.as_ref(), offer.nonce.to_le_bytes().as_ref()],
        bump = offer.bump,
        constraint = offer.maker == maker.key(),
    )]
    pub offer: Account<'info, Offer>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    /// Taker: the account accepting the offer (must sign).
    pub taker: Signer<'info>,

    /// Maker: must sign to authorize transfer of their tokens (asset for Sell, $TASTE for Buy).
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"offer", offer.maker.as_ref(), offer.nonce.to_le_bytes().as_ref()],
        bump = offer.bump,
        constraint = offer.maker == maker.key(),
    )]
    pub offer: Box<Account<'info, Offer>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = maker_asset_ata.mint == offer.mint,
        constraint = maker_asset_ata.owner == maker.key(),
    )]
    pub maker_asset_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = taker_asset_ata.mint == offer.mint,
        constraint = taker_asset_ata.owner == taker.key(),
    )]
    pub taker_asset_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = maker_quote_ata.mint == quote_mint.key(),
        constraint = maker_quote_ata.owner == maker.key(),
    )]
    pub maker_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = taker_quote_ata.mint == quote_mint.key(),
        constraint = taker_quote_ata.owner == taker.key(),
    )]
    pub taker_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token program for the asset. Must be Token-2022.
    pub asset_token_program: Interface<'info, TokenInterface>,

    /// Token program for the quote ($TASTE). Must be Token-2022.
    pub quote_token_program: Interface<'info, TokenInterface>,
}

impl<'info> AcceptOffer<'info> {
    pub fn validate_token_2022(&self) -> Result<()> {
        require!(
            self.asset_token_program.key() == TOKEN_2022_PROGRAM_ID,
            OtcError::NotToken2022
        );
        require!(
            self.quote_token_program.key() == TOKEN_2022_PROGRAM_ID,
            OtcError::NotToken2022
        );
        Ok(())
    }
}
