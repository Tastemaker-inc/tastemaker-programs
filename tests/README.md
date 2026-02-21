# Program tests

## Full suite

- **`npm run test:full`** — Builds (with optional `cargo clean`), starts validator, deploys all programs including `rwa_transfer_hook`, runs **exhaustive** + **otc_market**. Takes ~15+ minutes. Use for CI or before pushing.

## Running a subset (faster iteration)

Tests in `exhaustive.ts` are **sequential**: later tests depend on state created by earlier ones (config → taste_token → project + funding + milestones → RWA → revenue → edge cases). You cannot run e.g. only "revenue_distribution" in isolation; that block expects an existing project, RWA mint, etc.

### Safe subsets (with dependencies included)

Run a subset by **grep pattern** so Mocha runs only matching `describe`/`it` titles. You must include all dependency groups in the pattern, or the subset will fail.

| Goal | Command | What runs | Approx time |
|------|---------|-----------|-------------|
| Config only | `npm run test:config` | project_escrow config, governance config, rwa_token config | ~2–4 min (build + deploy + ~30s tests) |
| Config + taste_token | `npm run test:taste` | project_escrow/governance/rwa_token config + taste_token (init, mint, burn, freeze) | ~3–5 min |
| Custom pattern | `npm run test:grep -- 'your-pattern'` | Any tests whose title matches | Depends on pattern |

Examples:

```bash
# Only the three config describes (no taste, no project)
npm run test:config

# Config (all three) and all taste_token tests (pattern is specific to avoid matching "config" in other test names)
npm run test:taste

# Single test by name
npm run test:grep -- "mint_receipt for first backer"

# Legacy claim flow (needs config + taste_token + legacy describe)
npm run test:grep -- "config|taste_token|claim_rwa_tokens_legacy"

# RWA + revenue (pattern must include everything that builds project/RWA first)
npm run test:grep -- "config|taste_token|project_escrow \+ governance|mint_receipt|runs 5 milestone|variable milestones|rwa_token|revenue_distribution"
```

**Important:** Use specific patterns so Mocha doesn't run extra tests. For example `config|taste_token` matches any title containing "config" (e.g. `initialize_revenue_config`), so prefer the full phrases: `project_escrow config|governance config|rwa_token config|taste_token` for the taste subset. For any pattern that includes **rwa_token**, **revenue_distribution**, or the full flow, `run-test-grep.sh` builds and deploys `rwa_transfer_hook` so those tests pass.

### When to use full vs grep

- **Changing config or taste_token** → `npm run test:config` or `npm run test:taste` to iterate quickly.
- **Changing RWA, revenue, or governance flow** → Use a grep that includes all prerequisites (see example above), or run `npm run test:full` when you want the full run.
- **CI** → Keep running `npm run test:full` once per push so the full suite is validated.

## Dependency order (exhaustive.ts)

Rough order of describes; later ones assume state from earlier ones:

1. **project_escrow config**, **governance config**, **rwa_token config** — create config accounts (no shared state between them).
2. **taste_token** — init mint, treasury, mints to backers (uses config).
3. **project_escrow + governance full flow** — artist creates project, backers fund, mint_receipt, 5 milestone proposals (uses taste + config).
4. **variable milestones** — 2-milestone project (uses same world).
5. **rwa_token** — init RWA mint, claim, transfer hook, close (uses project from 3).
6. **revenue_distribution** — init config, deposit, claim, close_epoch (uses project + RWA).
7. **claim_rwa_tokens_legacy**, **governance cancel_proposal**, **project_escrow cancel and refund**, **quadratic voting**, **negative and edge cases** — various edge/negative tests (use state from above).

Splitting the file into truly independent files would require either duplicating the long setup in each file or a shared “fixture” that seeds the validator; the current single file keeps one sequential run and uses grep for subsets.
