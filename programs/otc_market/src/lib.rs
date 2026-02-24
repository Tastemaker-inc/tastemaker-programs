//! TasteMaker OTC marketplace: on-chain offers for IOU receipt NFTs and RWA tokens.
//! Token-2022 only for asset and quote mint. Escrow: maker deposits on create; taker-only sign on accept.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked};

#[cfg(not(feature = "devnet"))]
declare_id!("28hoarPFUJTqSJFg9gCQf1qpngkVMm63ZwcJV7X4GDkZ");
#[cfg(feature = "devnet")]
declare_id!("6FM7VKFLyzxubAhCY58rR1R42tuuVNY7QdAtNTq65EjN");

/// SPL Token-2022 program ID. Marketplace accepts only Token-2022 assets and quote.
pub static TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[program]
pub mod otc_market {
    use super::*;

    /// Placeholder: no-op init for deploy. Use create_offer / cancel_offer / accept_offer.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Create an offer (sell or buy). Maker deposits asset (sell) or TASTE (buy) into escrow. Token-2022 only.
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

        let asset_decimals = ctx.accounts.asset_mint.decimals;
        let maker = ctx.accounts.maker.to_account_info();

        match offer_type {
            OfferType::Sell => {
                require!(
                    ctx.accounts.quote_token_program.key() == TOKEN_2022_PROGRAM_ID,
                    OtcError::NotToken2022
                );
                let transfer = TransferChecked {
                    from: ctx.accounts.maker_asset_ata.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.escrow_ata.to_account_info(),
                    authority: maker,
                };
                let cpi =
                    CpiContext::new(ctx.accounts.asset_token_program.to_account_info(), transfer);
                anchor_spl::token_interface::transfer_checked(cpi, amount, asset_decimals)
                    .map_err(|_| OtcError::EscrowTransferFailed)?;
            }
            OfferType::Buy => {
                let quote_decimals = ctx.accounts.quote_mint.decimals;
                require!(
                    ctx.accounts.quote_token_program.key() == TOKEN_2022_PROGRAM_ID,
                    OtcError::NotToken2022
                );
                let transfer = TransferChecked {
                    from: ctx.accounts.maker_quote_ata.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.escrow_ata.to_account_info(),
                    authority: maker,
                };
                let cpi =
                    CpiContext::new(ctx.accounts.quote_token_program.to_account_info(), transfer);
                anchor_spl::token_interface::transfer_checked(cpi, price, quote_decimals)
                    .map_err(|_| OtcError::EscrowTransferFailed)?;
            }
        }

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

    /// Cancel an open offer. Only the maker can cancel. Returns escrowed tokens to maker.
    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        let offer = &ctx.accounts.offer;
        require!(
            matches!(offer.status, OfferStatus::Open),
            OtcError::OfferNotOpen
        );
        require!(ctx.accounts.maker.key() == offer.maker, OtcError::NotMaker);

        let nonce_bytes = offer.nonce.to_le_bytes();
        let (_, escrow_bump) = Pubkey::find_program_address(
            &[b"escrow", offer.maker.as_ref(), nonce_bytes.as_ref()],
            ctx.program_id,
        );
        let seeds: &[&[u8]] = &[
            b"escrow",
            offer.maker.as_ref(),
            nonce_bytes.as_ref(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        match offer.offer_type {
            OfferType::Sell => {
                let amount = offer.amount;
                let decimals = ctx.accounts.asset_mint.decimals;
                let transfer = TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.maker_asset_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                };
                let cpi = CpiContext::new_with_signer(
                    ctx.accounts.asset_token_program.to_account_info(),
                    transfer,
                    signer_seeds,
                );
                anchor_spl::token_interface::transfer_checked(cpi, amount, decimals)
                    .map_err(|_| OtcError::EscrowTransferFailed)?;
            }
            OfferType::Buy => {
                let price = offer.price;
                let decimals = ctx.accounts.quote_mint.decimals;
                let transfer = TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.maker_quote_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                };
                let cpi = CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    transfer,
                    signer_seeds,
                );
                anchor_spl::token_interface::transfer_checked(cpi, price, decimals)
                    .map_err(|_| OtcError::EscrowTransferFailed)?;
            }
        }

        let offer = &mut ctx.accounts.offer;
        offer.status = OfferStatus::Cancelled;
        msg!("Offer cancelled: {}", ctx.accounts.offer.key());
        Ok(())
    }

    /// Accept an open offer. Asset and $TASTE move via escrow; taker signs only.
    /// For Sell: escrow -> taker (asset), taker -> maker ($TASTE). For Buy: taker -> maker (asset), escrow -> taker ($TASTE).
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
        let offer_type = offer.offer_type;
        let offer_amount = offer.amount;
        let offer_price = offer.price;

        let nonce_bytes = offer.nonce.to_le_bytes();
        let (_, escrow_bump) = Pubkey::find_program_address(
            &[b"escrow", offer.maker.as_ref(), nonce_bytes.as_ref()],
            ctx.program_id,
        );
        let seeds: &[&[u8]] = &[
            b"escrow",
            offer.maker.as_ref(),
            nonce_bytes.as_ref(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        match offer_type {
            OfferType::Sell => {
                let transfer_asset = TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    mint: asset_mint.to_account_info(),
                    to: ctx.accounts.taker_asset_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                };
                let cpi_asset = CpiContext::new_with_signer(
                    ctx.accounts.asset_token_program.to_account_info(),
                    transfer_asset,
                    signer_seeds,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_asset,
                    offer_amount,
                    asset_decimals,
                )
                .map_err(|_| OtcError::EscrowTransferFailed)?;

                let transfer_quote = TransferChecked {
                    from: ctx.accounts.taker_quote_ata.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.maker_quote_ata.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                };
                let cpi_quote = CpiContext::new(
                    ctx.accounts.quote_token_program.to_account_info(),
                    transfer_quote,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_quote,
                    offer_price,
                    taste_decimals,
                )?;
            }
            OfferType::Buy => {
                let transfer_asset = TransferChecked {
                    from: ctx.accounts.taker_asset_ata.to_account_info(),
                    mint: asset_mint.to_account_info(),
                    to: ctx.accounts.maker_asset_ata.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                };
                let cpi_asset = CpiContext::new(
                    ctx.accounts.asset_token_program.to_account_info(),
                    transfer_asset,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_asset,
                    offer_amount,
                    asset_decimals,
                )?;

                let transfer_quote = TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.taker_quote_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                };
                let cpi_quote = CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    transfer_quote,
                    signer_seeds,
                );
                anchor_spl::token_interface::transfer_checked(
                    cpi_quote,
                    offer_price,
                    taste_decimals,
                )
                .map_err(|_| OtcError::EscrowTransferFailed)?;
            }
        }

        let offer = &mut ctx.accounts.offer;
        offer.status = OfferStatus::Taken;
        msg!(
            "Offer accepted: {} tokens for {} lamports",
            offer_amount,
            offer_price
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
    #[msg("Escrow transfer failed")]
    EscrowTransferFailed,
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

    /// For Sell: maker's asset ATA (source). For Buy: unused but required for account layout.
    #[account(
        mut,
        constraint = maker_asset_ata.mint == asset_mint.key(),
        constraint = maker_asset_ata.owner == maker.key(),
    )]
    pub maker_asset_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// For Buy: maker's quote ATA (source). For Sell: unused but required for account layout.
    #[account(
        mut,
        constraint = maker_quote_ata.owner == maker.key(),
    )]
    pub maker_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// PDA: signer for escrow ATA. Seeds = [b"escrow", maker, nonce].
    /// CHECK: PDA validated by seeds; used as token account authority for CPI with invoke_signed.
    #[account(
        seeds = [b"escrow", maker.key().as_ref(), maker_state.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    /// Escrow ATA: for Sell holds asset; for Buy holds quote. Owner = escrow_authority.
    #[account(
        mut,
        constraint = escrow_ata.owner == escrow_authority.key(),
    )]
    pub escrow_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Quote mint ($TASTE). Required for Buy; for Sell used to validate quote_token_program.
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Token program for the asset mint. Must be Token-2022.
    pub asset_token_program: Interface<'info, TokenInterface>,

    /// Token program for the quote mint. Must be Token-2022.
    pub quote_token_program: Interface<'info, TokenInterface>,

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

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = maker_asset_ata.owner == maker.key(),
        constraint = maker_asset_ata.mint == offer.mint,
    )]
    pub maker_asset_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = maker_quote_ata.owner == maker.key(),
    )]
    pub maker_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA validated by seeds; used as token authority for escrow return CPI with invoke_signed.
    #[account(
        seeds = [b"escrow", offer.maker.as_ref(), offer.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = escrow_ata.owner == escrow_authority.key(),
    )]
    pub escrow_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    /// Taker: the only signer; instant execution.
    pub taker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"offer", offer.maker.as_ref(), offer.nonce.to_le_bytes().as_ref()],
        bump = offer.bump,
    )]
    pub offer: Box<Account<'info, Offer>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = maker_asset_ata.mint == offer.mint,
        constraint = maker_asset_ata.owner == offer.maker,
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
        constraint = maker_quote_ata.owner == offer.maker,
    )]
    pub maker_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = taker_quote_ata.mint == quote_mint.key(),
        constraint = taker_quote_ata.owner == taker.key(),
    )]
    pub taker_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA validated by seeds; used as token authority for escrow CPI with invoke_signed.
    #[account(
        seeds = [b"escrow", offer.maker.as_ref(), offer.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = escrow_ata.owner == escrow_authority.key(),
    )]
    pub escrow_ata: Box<InterfaceAccount<'info, TokenAccount>>,

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
