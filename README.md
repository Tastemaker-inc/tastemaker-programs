# TasteMaker Programs

[![CI](https://github.com/Tastemaker-inc/tastemaker-programs/actions/workflows/ci.yml/badge.svg)](https://github.com/Tastemaker-inc/tastemaker-programs/actions/workflows/ci.yml)

On-chain programs for [TasteMaker](https://tastemaker.music): platform token ($TASTE), project escrow, backer governance (milestone release), and per-project RWA tokens.

## Programs

| Program | Description |
|---------|-------------|
| **taste_token** | $TASTE mint (9 decimals). Init, mint to treasury/recipient, burn. |
| **project_escrow** | Create project, fund with $TASTE; milestone release only via governance CPI. `release_milestone` / `complete_project` require the governance release PDA as signer (no admin key). |
| **governance** | Proposals + quadratic voting; finalize CPIs `release_milestone` via release PDA signer. |
| **rwa_token** | Per-project RWA mint; backers claim by share; close to freeze. |
| **revenue_distribution** | Per-project revenue config; artist deposits $TASTE, holders claim proportional share by epoch; close_epoch sweeps unclaimed. |
| **otc_market** | OTC marketplace: create/cancel/accept offers for IOU and RWA tokens, priced in $TASTE (Token-2022 only). |

## Requirements

- [Rust](https://rustup.rs/) (stable)
- [Anchor](https://www.anchor-lang.com/) 0.32.x
- Node 18+ (for tests)

## Build

```bash
anchor build
```

## IDL

Pre-built IDL JSON files for each program are in the [`idl/`](idl/) directory. They use the **devnet** program IDs from the table below and match `Anchor.toml` `[programs.devnet]` and the web app (`web/lib/constants.ts`). Use them with `@coral-xyz/anchor` or other clients without building from source. Regenerate after program changes with `anchor build` then copy `target/idl/*.json` into `idl/` (and run the governance PDA patch if needed; see `scripts/patch-governance-idl.cjs`).

## Test

```bash
yarn install
anchor test
```

Runs the exhaustive integration test against a local validator. The test script in `Anchor.toml` compiles `tests/exhaustive.ts` to JavaScript with [esbuild](https://esbuild.github.io/) and runs [mocha](https://mochajs.org/) on the output so Node never loads `.ts` directly (avoids "Unknown file extension .ts" with Node 20+ / Anchor 0.32). For a lighter smoke test, run `npx ts-mocha -p ./tsconfig.json -t 30000 tests/integration.ts` after `anchor build` (uses default provider cluster).

**Exhaustive test suite** (40 backers, 5 milestones, quadratic voting, RWA claim):

```bash
npm run test:full
```

Uses localnet (same program IDs as devnet per `Anchor.toml`). Build with test feature for 1s voting period: `anchor build -- --features test` then `npm run test:full`.

**Verify program IDs** after deploy: `anchor keys list` (compares keypairs under `target/deploy/` with `declare_id!` in each program).

## Deploy (devnet)

1. Generate program keypairs and set program IDs in `Anchor.toml` and `declare_id!` in each program.
2. Run:

```bash
anchor deploy --provider.cluster devnet
```

See `public_docs/README.md` for public runbooks and flow docs.

## Official Deployments (devnet)

**Canonical devnet program IDs.** These match `Anchor.toml` `[programs.devnet]` and the web app (`web/lib/constants.ts`). Use them for deploy, upgrades, and client configuration.

| Program               | Program ID | Devnet |
|-----------------------|------------|--------|
| taste_token           | `2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo` | [Explorer](https://explorer.solana.com/address/2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo?cluster=devnet) |
| project_escrow        | `bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym` | [Explorer](https://explorer.solana.com/address/bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym?cluster=devnet) |
| governance            | `AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK` | [Explorer](https://explorer.solana.com/address/AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK?cluster=devnet) |
| rwa_token             | `GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE` | [Explorer](https://explorer.solana.com/address/GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE?cluster=devnet) |
| revenue_distribution  | `C7qE7zNk7YA9rLhqRejFpMPH9y2Ds8rYZs2WEyhxUUWK` | [Explorer](https://explorer.solana.com/address/C7qE7zNk7YA9rLhqRejFpMPH9y2Ds8rYZs2WEyhxUUWK?cluster=devnet) |
| otc_market            | `6FM7VKFLyzxubAhCY58rR1R42tuuVNY7QdAtNTq65EjN` | [Explorer](https://explorer.solana.com/address/6FM7VKFLyzxubAhCY58rR1R42tuuVNY7QdAtNTq65EjN?cluster=devnet) |
| rwa_transfer_hook     | `HAC2Q2ecWgDXHt34bs1afuGqUsKfxycqd2MXuWHkRgRj` | [Explorer](https://explorer.solana.com/address/HAC2Q2ecWgDXHt34bs1afuGqUsKfxycqd2MXuWHkRgRj?cluster=devnet) |

All devnet programs use upgrade authority `F5u4r8NCAqQ526WcoNX4KY4qBke1hWFMcrMaTRNm1dBU`. To verify (confirm `Last Deployed In Slot` and `Authority`):

```bash
solana program show 2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo --url devnet
solana program show bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym --url devnet
solana program show AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK --url devnet
solana program show GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE --url devnet
solana program show C7qE7zNk7YA9rLhqRejFpMPH9y2Ds8rYZs2WEyhxUUWK --url devnet
solana program show 6FM7VKFLyzxubAhCY58rR1R42tuuVNY7QdAtNTq65EjN --url devnet
solana program show HAC2Q2ecWgDXHt34bs1afuGqUsKfxycqd2MXuWHkRgRj --url devnet
```

Programs must be deployed to devnet for the Explorer links to show program data.

## Docs

- [Public docs index](public_docs/README.md)
- [Deploy Devnet](public_docs/DEPLOY_DEVNET.md) — deploy/upgrade all programs (including **project_escrow**, rwa_token, governance, otc_market, taste_token); upgrade authority and verify commands are in that doc and in `.cursor/rules/devnet-deploy-upgrade.mdc` (monorepo).
- [CI Debug Guide](public_docs/CI_DEBUG_GUIDE.md)
- [OTC Marketplace](public_docs/OTC_MARKETPLACE.md)

## Security

Vulnerabilities in the on-chain programs should be reported to **security@tastemaker.music**. See [SECURITY.md](SECURITY.md) for scope, response timeline, and safe harbor.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the PR process.

## License

MIT. See [LICENSE](LICENSE).
