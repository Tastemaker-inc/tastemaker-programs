/**
 * One-time script: initialize project_escrow Config PDA with the governance release authority PDA.
 *
 * Why this exists:
 * - The `project_escrow::initialize_config(governance_release_authority)` instruction must be called once per network.
 * - It can only be called by the **program upgrade authority** (validated on-chain by reading the upgradeable loader state).
 * - Our committed IDL may not include `initialize_config`, so this script constructs the Anchor instruction directly.
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npm run init-escrow-config
 *
 * Env:
 * - SOLANA_RPC_URL or ANCHOR_PROVIDER_URL: RPC endpoint (defaults to devnet)
 * - SOLANA_KEYPAIR: upgrade authority keypair (defaults to ~/.config/solana/devnet-deploy.json)
 * - PROJECT_ESCROW_PROGRAM_ID: override program id (defaults to the on-chain devnet id in the program)
 * - GOVERNANCE_PROGRAM_ID: override governance program id (defaults to the on-chain devnet id in the program)
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const RPC = process.env.SOLANA_RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";

// Defaults should match devnet deployments (Anchor.toml + web/lib/constants.ts).
// Localnet IDs are different; override via env if running against local validator.
const DEFAULT_PROJECT_ESCROW_PROGRAM_ID = "bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym";
const DEFAULT_GOVERNANCE_PROGRAM_ID = "AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK";

const PROJECT_ESCROW_PROGRAM_ID = new PublicKey(
  process.env.PROJECT_ESCROW_PROGRAM_ID ?? DEFAULT_PROJECT_ESCROW_PROGRAM_ID
);
const GOVERNANCE_PROGRAM_ID = new PublicKey(process.env.GOVERNANCE_PROGRAM_ID ?? DEFAULT_GOVERNANCE_PROGRAM_ID);

const DEFAULT_DEVNET_DEPLOY_KEYPAIR = path.join(
  process.env.HOME ?? require("os").homedir(),
  ".config/solana/devnet-deploy.json"
);

function loadKeypair(): Keypair {
  const keypairPath = process.env.SOLANA_KEYPAIR ?? DEFAULT_DEVNET_DEPLOY_KEYPAIR;
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function anchorDiscriminator(ixName: string): Buffer {
  // Anchor discriminator = first 8 bytes of sha256("global:<ix_name>")
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

async function getProgramDataAddress(connection: Connection, programId: PublicKey): Promise<PublicKey> {
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (!programInfo) {
    throw new Error(
      `Program account not found: ${programId.toBase58()}. ` +
        `Double-check you're on the right cluster (RPC=${RPC}) and that PROJECT_ESCROW_PROGRAM_ID/GOVERNANCE_PROGRAM_ID match Anchor.toml [programs.devnet] (or override via env).`
    );
  }
  if (!programInfo.executable) throw new Error(`Account is not executable (not a program): ${programId.toBase58()}`);
  if (programInfo.data.length < 36) throw new Error(`Program account data too short: ${programInfo.data.length}`);

  // Matches on-chain logic in `require_upgrade_authority` in project_escrow:
  // u32 discriminant == 2 (Program) + 32-byte programdata address.
  const disc = Buffer.from(programInfo.data.subarray(0, 4)).readUInt32LE(0);
  if (disc !== 2) {
    throw new Error(`Unexpected upgradeable loader state (expected 2, got ${disc}). Is this an upgradeable program?`);
  }
  return new PublicKey(programInfo.data.subarray(4, 36));
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROJECT_ESCROW_PROGRAM_ID);
  const [releaseAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from("release_authority")], GOVERNANCE_PROGRAM_ID);

  console.log("RPC:", RPC);
  console.log("project_escrow program:", PROJECT_ESCROW_PROGRAM_ID.toBase58());
  console.log("governance program:", GOVERNANCE_PROGRAM_ID.toBase58());
  console.log("Upgrade authority signer:", payer.publicKey.toBase58());
  console.log("Config PDA:", configPda.toBase58());
  console.log("Governance release authority PDA:", releaseAuthorityPda.toBase58());

  const existing = await connection.getAccountInfo(configPda, "confirmed");
  if (existing) {
    const stored = existing.data.length >= 40 ? new PublicKey(existing.data.subarray(8, 40)).toBase58() : "(unreadable)";
    console.log("Config already exists. Stored governance_release_authority =", stored);
    process.exit(0);
    return;
  }

  const programDataAddress = await getProgramDataAddress(connection, PROJECT_ESCROW_PROGRAM_ID);
  console.log("ProgramData account:", programDataAddress.toBase58());

  const data = Buffer.concat([anchorDiscriminator("initialize_config"), releaseAuthorityPda.toBuffer()]);
  const ix = new TransactionInstruction({
    programId: PROJECT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // authority (payer)
      { pubkey: configPda, isSigner: false, isWritable: true }, // config (init)
      { pubkey: PROJECT_ESCROW_PROGRAM_ID, isSigner: false, isWritable: false }, // program_account
      { pubkey: programDataAddress, isSigner: false, isWritable: false }, // program_data_account
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;

  console.log("Sending initialize_config transaction...");
  const sig = await connection.sendTransaction(tx, [payer], { skipPreflight: false, preflightCommitment: "confirmed" });
  console.log("Signature:", sig);

  await connection.confirmTransaction(sig, "confirmed");
  console.log("Confirmed. Config PDA initialized.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

