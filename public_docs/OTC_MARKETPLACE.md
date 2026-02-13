# OTC Marketplace Program (Public)

On-chain OTC marketplace for IOU receipts and RWA tokens.

## Program

- Name: `otc_market`
- Instructions: `create_offer`, `cancel_offer`, `accept_offer`
- Offer modes: sell / buy
- Pricing: quote asset is `$TASTE`

## Token standard requirement

- Token-2022 is required for marketplace assets and quote token flows.

## Operational note

- Marketplace create/accept actions fail on a network where `otc_market` is not deployed.
