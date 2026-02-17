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

## Web app behavior (marketplace UI)

- The web app hides **sell** listings for IOU (receipt) mints whose RWA has already been claimed (receipt no longer redeemable). The on-chain offer is not cancelled; it is filtered from the list. See monorepo `build/MARKETPLACE_RWA_ALREADY_CLAIMED_DISABLE.md` for details.
- After a backer claims RWA, the app notifies them that any receipt listing was removed (POST `/api/notifications/listing-invalid-rwa-claimed`).
