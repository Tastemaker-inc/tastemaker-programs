/**
 * Recovery: mark project Completed when all milestones are released but status stuck Active
 * (e.g. finalized with old program that expected 5 milestones). Upgrade authority only.
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npx ts-node scripts/force-complete-project.ts <PROJECT_PDA>
 *
 * Env:
 * - SOLANA_RPC_URL or ANCHOR_PROVIDER_URL: RPC (default devnet)
 * - SOLANA_KEYPAIR: upgrade authority keypair (default ~/.config/solana/devnet-deploy.json)
 * - PROJECT_ESCROW_PROGRAM_ID: override (default devnet)
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const RPC = process.env.SOLANA_RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const PROJECT_ESCROW_PROGRAM_ID = new PublicKey(
  process.env.PROJECT_ESCROW_PROGRAM_ID ?? "bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym"
);

const DEFAULT_DEVNET_DEPLOY_KEYPAIR = path.join(
  process.env.HOME ?? require("os").homedir(),
  ".config/solana/devnet-deploy.json"
);

function loadKeypair(): Keypair {
  const keypairPath = process.env.SOLANA_KEYPAIR ?? DEFAULT_DEVNET_DEPLOY_KEYPAIR;
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getProjectPda(): PublicKey {
  const raw = process.env.PROJECT_PDA ?? process.argv[2];
  if (!raw || typeof raw !== "string") {
    console.error("Usage: npx ts-node scripts/force-complete-project.ts <PROJECT_PDA>");
    process.exit(1);
  }
  return new PublicKey(raw);
}

function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

async function getProgramDataAddress(connection: Connection, programId: PublicKey): Promise<PublicKey> {
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (!programInfo || !programInfo.executable || programInfo.data.length < 36) {
    throw new Error(`Program account not found or invalid: ${programId.toBase58()}`);
  }
  const disc = Buffer.from(programInfo.data.subarray(0, 4)).readUInt32LE(0);
  if (disc !== 2) throw new Error(`Unexpected loader state: ${disc}`);
  return new PublicKey(programInfo.data.subarray(4, 36));
}

async function main() {
  const authority = loadKeypair();
  const projectPda = getProjectPda();
  const connection = new Connection(RPC, "confirmed");

  const programDataAddress = await getProgramDataAddress(connection, PROJECT_ESCROW_PROGRAM_ID);

  const data = anchorDiscriminator("force_complete_project");
  const ix = new TransactionInstruction({
    programId: PROJECT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: projectPda, isSigner: false, isWritable: true },
      { pubkey: PROJECT_ESCROW_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programDataAddress, isSigner: false, isWritable: false },
    ],
    data,
  });

  console.log("RPC:", RPC);
  console.log("Project PDA:", projectPda.toBase58());
  console.log("Upgrade authority:", authority.publicKey.toBase58());

  const tx = new Transaction().add(ix);
  const sig = await connection.sendTransaction(tx, [authority], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("Signature:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("Project marked Completed. Artist can now call initialize_rwa_mint, or run: npm run initialize-rwa-mint");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
