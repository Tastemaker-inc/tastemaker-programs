# RWA Token Patterns

Per-project RWA mint and pull-based distribution.

## Model

- One RWA mint per project (keyed by project_escrow Project pubkey).
- **Total supply** set at `initialize_rwa_mint` (artist-defined or 1:1 with $TASTE raised).
- **Distribution**: pull model. Backer calls `claim_rwa_tokens()`; share = `(backer_amount * total_supply) / total_raised`; tokens minted to backer ATA. One claim per backer (ClaimRecord PDA).
- **Close**: RwaState.authority calls `close_distribution` to set `mint_frozen = true`.

## Accounts

- **RwaState** (PDA `[b"rwa_state", project]`): project, authority, total_supply, minted, mint_frozen.
- **RwaMint** (PDA `[b"rwa_mint", project]`): SPL mint, decimals 6; authority = PDA `[b"rwa_mint_authority", project]`.
- **ClaimRecord** (PDA `[b"claim", project, backer]`): claimed (bool), prevents double claim.
- Backer ATA: associated token account (mint = RwaMint, owner = backer).

## Usage

1. After project is completed (all milestones released), authority (e.g. artist) calls `initialize_rwa_mint(total_supply)`. Project account (project_escrow Project) is passed for PDA seeds; authority is stored in RwaState.
2. Each backer calls `claim_rwa_tokens()` with Backer and Project accounts; share is computed from on-chain data; ClaimRecord prevents double claim.
3. When distribution is done, the same authority calls `close_distribution` to freeze the mint.

## Decimals

RWA mint uses 6 decimals by default (adjust in program if needed).
