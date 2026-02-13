# Contributing to TasteMaker Programs

Thank you for your interest in contributing. This document covers how to set up, develop, and submit changes.

## Prerequisites

- **Rust** (stable): [rustup.rs](https://rustup.rs/)
- **Anchor** 0.32.x: [anchor-lang.com](https://www.anchor-lang.com/)
- **Solana CLI** (for local validator and deploy)
- **Node** 18+ (for tests)

## Setup

```bash
yarn install
anchor build
```

To run the full test suite (local validator, 40 backers, 5 milestones, ~7 min):

```bash
npm run test:full
```

If CI/test debugging gets stuck, read `docs/CI_AGENT_PLAYBOOK.md` before changing validator flow or wallet assumptions.

## Code Style

- **Rust:** Run `cargo fmt` and `cargo clippy --all-targets -- -D warnings` before committing.
- **TypeScript:** Run `npm run lint:fix` (Prettier).

CI will fail if formatting or Clippy checks do not pass.

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes and add or update tests as needed.
3. Run the full test suite locally: `npm run test:full`.
4. Open a **pull request** against `main` with a clear description of the change.
5. Ensure CI passes (build + tests).

All PRs must pass the full test suite. New features or instruction changes should include test coverage.

## Commit Messages

Use imperative mood and a concise summary line, e.g.:

- `Add error code for invalid milestone index`
- `Fix PDA derivation in create_proposal`

## Commit Signing

- Use signed commits for release-critical changes: `git commit -S`.
- Follow `docs/GIT_SIGNING_RULES.md` for expected SSH signing setup and troubleshooting.

## Issues

Use [GitHub Issues](https://github.com/Tastemaker-inc/tastemaker-programs/issues) for bugs and feature requests. Include reproduction steps for bugs.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
