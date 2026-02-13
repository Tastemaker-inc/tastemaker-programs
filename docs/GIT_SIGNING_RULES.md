# Git Signing Rules

This repository expects signed commits for release-critical changes.

## Required behavior

- Use SSH commit signing when committing:
  - `git commit -S ...`
- Do not change signing key configuration from automation/agents.
- Do not create alternate identities for convenience during CI/debug work.
- Keep deploy authority key management separate from git signing keys.

## Pre-commit verification

Before committing, confirm local signing config is already present:

```bash
git config --get gpg.format
git config --get user.signingkey
git config --get commit.gpgsign
```

Expected:

- `gpg.format=ssh`
- `user.signingkey` points to the expected SSH key
- `commit.gpgsign=true`

## If signature appears missing

- Re-run commit as signed (`-S`) after confirming key is loaded/available.
- If verification output complains about `gpg.ssh.allowedSignersFile`, that is a **verification setup issue**, not necessarily a failed signing attempt.
- Do not bypass signing for release branches.

## CI/Agent note

- Agents must not mutate global git config to force signing.
- If signing fails due local environment state, stop and ask the user to restore their signing environment.
