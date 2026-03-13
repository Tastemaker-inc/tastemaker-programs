# Updated Issue Text for GitHub

Copy each section below into the corresponding GitHub issue. These revisions add contributor framing, time estimates, and fix broken doc references.

---

## Issue #1 — Error code reference table

**Replace the full issue body with:**

---

### Summary

Each program defines custom error codes (e.g. `InvalidMilestonePercentages`, `QuorumNotMet`), but none of the documentation lists them. Developers integrating against the IDL or debugging failed transactions have to read the Rust source to find error meanings.

### Why contribute here?

- **Low risk:** Documentation only, no program changes
- **~1–2 hours:** Read source, extract enums, format tables
- **High impact:** Every integrator and debugger will use this reference
- **Learn:** You'll understand Anchor error codes and our program error model

### What to do

Add an error code reference for each program. Create **`public_docs/ERROR_CODES.md`** with a table per program.

#### Format (per program)

```markdown
### project_escrow

| Code | Name | Description |
|------|------|-------------|
| 6000 | InvalidMilestonePercentages | Milestone percentages must sum to 100 |
| 6001 | ProjectNotActive | Project is not active |
| ... | ... | ... |
```

### First step

1. Browse the source on GitHub (or clone locally — no build needed)
2. Open `programs/project_escrow/src/lib.rs` and search for `#[error_code]` and `pub enum EscrowError`
3. Copy each variant and its `#[msg("...")]` into a table row
4. Repeat for the other five programs

### Where to find the error enums

| Program | File |
|---------|------|
| taste_token | `programs/taste_token/src/lib.rs` — `TasteError` |
| project_escrow | `programs/project_escrow/src/lib.rs` — `EscrowError` |
| governance | `programs/governance/src/lib.rs` — `GovError` |
| rwa_token | `programs/rwa_token/src/lib.rs` — `RwaError` |
| revenue_distribution | `programs/revenue_distribution/src/lib.rs` — `RevError` |
| otc_market | `programs/otc_market/src/lib.rs` — `OtcError` |

Anchor maps custom errors starting at 6000 (0x1770). The numeric code is the enum variant's discriminant.

### Acceptance criteria

- [ ] All error codes from all six programs are documented with name, numeric code, and one-line description
- [ ] File is `public_docs/ERROR_CODES.md` and linked from `public_docs/README.md`
- [ ] No Rust source reading required to understand what an error means

### Notes

If you spot an error code that seems unclear or unused, note it in your PR description. We'll review the format in your PR — don't worry about getting it perfect on the first try.

---

## Issue #2 — Document complete_project instruction

**Replace the full issue body with:**

---

### Summary

`project_escrow` has a `complete_project` instruction that exists in source but is:

- **Not documented** anywhere in `public_docs/`
- **Not called** in either test suite (`exhaustive.ts` or `integration.ts`)

Meanwhile, `release_milestone` already transitions a project to `Completed` when the final milestone is released. So: is `complete_project` redundant, or does it serve a distinct purpose?

### Why contribute here?

- **Low risk:** Documentation or design recommendation only
- **~1–2 hours:** Read the instruction, compare to `release_milestone`, write it up
- **Impact:** Resolves an auditor/contributor finding before it becomes a problem
- **Learn:** You'll understand project state machines and Anchor instruction design

### What to do

1. Read `complete_project` in `programs/project_escrow/src/lib.rs` (around line 466)
2. Compare its behavior to the automatic completion in `release_milestone` (around line 456–463)
3. Either:
   - **Document it:** Add a section to a new `public_docs/ESCROW_FLOW.md` (or extend an existing doc) explaining when and why it would be called, OR
   - **Recommend removal:** If it's redundant, open a discussion in your PR with reasoning

### First step

1. Open `programs/project_escrow/src/lib.rs`
2. Search for `complete_project` and read the handler
3. Search for `release_milestone` and see where it sets `ProjectStatus::Completed`
4. Decide: same behavior or different? Then write it up

### Acceptance criteria

- [ ] `complete_project` is either documented with a clear use case, or a removal recommendation is made with reasoning
- [ ] If documented: who can call it, what state transitions it triggers, and how it differs from automatic completion in `release_milestone`

### Context

`complete_project` requires `ProjectStatus::Active` and `current_milestone >= effective_milestone_count`. So does the auto-completion in `release_milestone`. The main question: is there a path where one is needed and the other isn't?

---

## Issue #3 — Fee structure breakdown

**Replace the full issue body with:**

---

### Summary

The `fund_project` instruction in `project_escrow` charges a 4% fee on every funding transaction:

- **2% to platform treasury** (transferred to the treasury token account)
- **2% burned** (tokens destroyed)

This fee logic is implemented in Rust but not documented. Anyone reading the docs to understand the economic model has to go to source code.

### Why contribute here?

- **Low risk:** Documentation only
- **~1 hour:** Read one instruction, extract the math, write a short doc
- **Impact:** Essential for anyone modeling economics or building on the platform
- **Learn:** You'll see how Solana programs handle fee splits and burns

### What to do

Create **`public_docs/FEES.md`** (or add a "Fees" section to an existing doc) that covers:

1. **Primary funding fee:** 4% total on `fund_project` (2% treasury, 2% burn). The artist's escrow receives 96% of what the backer sends.
2. **Where it's calculated:** In the `fund_project` instruction handler (`programs/project_escrow/src/lib.rs`, around line 283)
3. **Token flow diagram** (text is fine):

```
Backer sends 100 $TASTE
  → 96 $TASTE to project escrow vault
  → 2 $TASTE to platform treasury
  → 2 $TASTE burned
```

4. **Secondary market fees:** If any are planned or implemented, document them. If not, note "TBD" or "planned" with a reference.

### First step

1. Open `programs/project_escrow/src/lib.rs`
2. Search for `fund_project` and read the fee calculation (look for `fee_treasury`, `fee_burn`, `to_escrow`)
3. Add `public_docs/FEES.md` and link it from `public_docs/README.md`

### Acceptance criteria

- [ ] Fee structure documented with percentages, recipient accounts, and a simple flow
- [ ] Linked from `public_docs/README.md`
- [ ] A reader can understand the full fee model without reading Rust

### Where to find the code

- `programs/project_escrow/src/lib.rs` — `fund_project` handler, lines ~295–310 (fee calculation) and the subsequent transfers

---

## Issue #4 and #5 — Recommendations

**#4 (SDK):** Consider closing or splitting. You know how to build it; external contributors are more likely to give advice (like klawgulp-ship-it) than implement. If you want to keep it open, split into smaller issues, e.g.:
- "Add PDA derivation helpers for project_escrow"
- "Add typed client for taste_token only"

**#5 (Revenue distribution RFC):** Keep as a discussion. Add a note: "This is a design discussion — we welcome comments and proposals. Implementation will follow once design is agreed."
