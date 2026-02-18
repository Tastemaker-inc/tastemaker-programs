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
