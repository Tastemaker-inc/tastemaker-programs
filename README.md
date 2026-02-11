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

## Requirements

- [Rust](https://rustup.rs/) (stable)
- [Anchor](https://www.anchor-lang.com/) 0.32.x
- Node 18+ (for tests)

## Build

```bash
anchor build
```

## IDL

Pre-built IDL JSON files for each program are in the [`idl/`](idl/) directory. Use them with `@coral-xyz/anchor` or other clients without building from source. CI verifies they stay in sync with the built programs.

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

See `docs/ARCHITECTURE.md` and `docs/ESCROW_FLOW.md`, `docs/GOVERNANCE_FLOW.md`, `docs/RWA_PATTERNS.md` for flows and PDAs.

## Official Deployments

| Program        | Program ID | Devnet |
|----------------|------------|--------|
| taste_token    | `2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo` | [Explorer](https://explorer.solana.com/address/2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo?cluster=devnet) |
| project_escrow | `bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym` | [Explorer](https://explorer.solana.com/address/bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym?cluster=devnet) |
| governance     | `AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK` | [Explorer](https://explorer.solana.com/address/AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK?cluster=devnet) |
| rwa_token      | `GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE` | [Explorer](https://explorer.solana.com/address/GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE?cluster=devnet) |

Programs must be deployed to devnet for the Explorer links to show program data.

## Docs

- [ARCHITECTURE](docs/ARCHITECTURE.md): programs, PDAs, build/test/deploy
- [ESCROW_FLOW](docs/ESCROW_FLOW.md): project lifecycle and escrow release
- [GOVERNANCE_FLOW](docs/GOVERNANCE_FLOW.md): proposals, voting, CPI to escrow
- [RWA_PATTERNS](docs/RWA_PATTERNS.md): per-project RWA mint and claim

## Security

Vulnerabilities in the on-chain programs should be reported to **security@tastemaker.music**. See [SECURITY.md](SECURITY.md) for scope, response timeline, and safe harbor.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the PR process.

## License

MIT. See [LICENSE](LICENSE).
