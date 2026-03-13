# Public Docs

This folder is the public-facing documentation surface for `tastemaker-programs`.

- Put externally shareable runbooks/guides here.
- Keep internal operating notes and team-specific workflows in `docs/`.
- Do not edit internal docs when preparing public docs; maintain them separately.

## Current public docs

| Doc | Covers |
|-----|--------|
| `DEPLOY_DEVNET.md` | Deploy and upgrade **all** devnet programs (taste_token, **project_escrow**, governance, otc_market, rwa_token). Upgrade authority, build with devnet feature, and `solana program deploy --program-id` flow. |
| `CI_DEBUG_GUIDE.md` | Public CI/debug workflow |
| `OTC_MARKETPLACE.md` | OTC program overview (create/cancel/accept offers; web app hide/notify for claimed IOUs) |

## Documentation gaps (help wanted)

These docs don't exist yet — good first issues for contributors:

| Doc | Issue | Description |
|-----|-------|-------------|
| `ERROR_CODES.md` | [#1](https://github.com/Tastemaker-inc/tastemaker-programs/issues/1) | Error code reference table for all programs |
| `FEES.md` | [#3](https://github.com/Tastemaker-inc/tastemaker-programs/issues/3) | Fee structure (4% on fund_project: 2% treasury, 2% burn) |
| `ESCROW_FLOW.md` | [#2](https://github.com/Tastemaker-inc/tastemaker-programs/issues/2) | Escrow lifecycle, including `complete_project` documentation |
