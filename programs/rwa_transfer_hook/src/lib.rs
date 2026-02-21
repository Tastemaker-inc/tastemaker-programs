//! TasteMaker RWA pass-through transfer hook.
//! Implements spl-transfer-hook-interface. Currently approves all transfers.
//! Upgradeable for future compliance (whitelist, holding periods, etc.).

#![allow(clippy::arithmetic_side_effects)]
#![deny(missing_docs)]
#![cfg_attr(not(test), forbid(unsafe_code))]

#[cfg(not(feature = "devnet"))]
solana_pubkey::declare_id!("56LtERCqfVTv84E2AtL3jrKBdFXD8QxQN74NmoyJjBPn");
#[cfg(feature = "devnet")]
solana_pubkey::declare_id!("HAC2Q2ecWgDXHt34bs1afuGqUsKfxycqd2MXuWHkRgRj");

pub mod processor;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint;
