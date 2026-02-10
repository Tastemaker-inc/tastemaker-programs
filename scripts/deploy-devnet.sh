#!/usr/bin/env bash
# Deploy all TasteMaker programs to devnet.
# Prereqs: anchor, solana CLI, wallet with SOL on devnet.
# Program IDs must be set in Anchor.toml and in each program's declare_id! before running.

set -e
anchor build
anchor deploy --provider.cluster devnet
echo "Deploy complete. Update deployments/devnet.json with program IDs if you use that file."
