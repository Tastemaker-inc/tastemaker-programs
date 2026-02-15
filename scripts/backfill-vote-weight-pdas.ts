/**
 * Backfill ProjectVoteWeight PDA for a project: sum sqrt(backer.amount) from all Backer accounts.
 *
 * Only the project_escrow upgrade authority can call set_vote_weight. Run on devnet for existing projects.
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npx ts-node scripts/backfill-vote-weight-pdas.ts <PROJECT_PDA>
 *
 * Env:
 * - SOLANA_RPC_URL, SOLANA_KEYPAIR: as above
 * - PROJECT_ESCROW_PROGRAM_ID: override (default devnet)
 * - ALLOW_NON_DEVNET=1: allow running on non-devnet when cluster guard is enabled
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.ANCHOR_PROVIDER_URL ??
  "https://api.devnet.solana.com";

const DEFAULT_PROJECT_ESCROW_PROGRAM_ID = "bJch5cLcCHTypbXrvRMr9MxU5HmN2LBRwF8wR4dXpym";
const PROJECT_ESCROW_PROGRAM_ID = new PublicKey(
  process.env.PROJECT_ESCROW_PROGRAM_ID ?? DEFAULT_PROJECT_ESCROW_PROGRAM_ID
);

const DEFAULT_DEVNET_DEPLOY_KEYPAIR = path.join(
  process.env.HOME ?? require("os").homedir(),
  ".config/solana/devnet-deploy.json"
);

// Backer layout: 8 discriminator + 32 wallet + 32 project + 8 amount + 1 claimed_rwa
const BACKER_AMOUNT_OFFSET = 8 + 32 + 32;

function loadKeypair(): Keypair {
  const keypairPath = process.env.SOLANA_KEYPAIR ?? DEFAULT_DEVNET_DEPLOY_KEYPAIR;
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function sqrtU64(x: bigint): bigint {
  if (x === BigInt(0)) return BigInt(0);
  let z = (x + BigInt(1)) / BigInt(2);
  let y = x;
  while (z < y) {
    y = z;
    z = (x / z + z) / BigInt(2);
  }
  return y;
}

function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

async function getProgramDataAddress(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey> {
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (!programInfo || !programInfo.executable || programInfo.data.length < 36) {
    throw new Error(`Invalid program: ${programId.toBase58()}`);
  }
  const disc = programInfo.data.readUInt32LE(0);
  if (disc !== 2) throw new Error("Expected upgradeable program.");
  return new PublicKey(programInfo.data.subarray(4, 36));
}

/** Devnet genesis hash; used to enforce cluster guard unless ALLOW_NON_DEVNET=1. */
const DEVNET_GENESIS_HASH = "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC";

async function main() {
  const projectPdaArg = process.argv[2];
  if (!projectPdaArg) {
    console.error("Usage: npx ts-node scripts/backfill-vote-weight-pdas.ts <PROJECT_PDA>");
    process.exit(1);
  }
  const projectPda = new PublicKey(projectPdaArg);

  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");

  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    if (process.env.ALLOW_NON_DEVNET !== "1") {
      console.error(
        "This script is intended for devnet. Current cluster genesis hash:",
        genesisHash,
        "\nSet ALLOW_NON_DEVNET=1 to run on a different cluster."
      );
      process.exit(1);
    }
  }

  const backerAccounts = await connection.getProgramAccounts(PROJECT_ESCROW_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 8 + 32,
          bytes: projectPda.toBase58(),
        },
      },
    ],
  });

  let totalVoteWeight = BigInt(0);
  for (const { account } of backerAccounts) {
    if (account.data.length < BACKER_AMOUNT_OFFSET + 8) continue;
    const amount = account.data.readBigUInt64LE(BACKER_AMOUNT_OFFSET);
    totalVoteWeight += sqrtU64(amount);
  }

  const totalVoteWeightU64 = totalVoteWeight > BigInt("18446744073709551615") ? BigInt("18446744073709551615") : totalVoteWeight;
  console.log("RPC:", RPC);
  console.log("Project:", projectPda.toBase58());
  console.log("Backer accounts:", backerAccounts.length);
  console.log("total_vote_weight (sum sqrt(amount)):", totalVoteWeightU64.toString());

  const [voteWeightPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vote_weight"), projectPda.toBuffer()],
    PROJECT_ESCROW_PROGRAM_ID
  );

  const existing = await connection.getAccountInfo(voteWeightPda, "confirmed");
  if (existing) {
    const current = existing.data.length >= 16 ? existing.data.readBigUInt64LE(8) : BigInt(0);
    console.log("Existing vote_weight PDA value:", current.toString());
  }

  const programDataAddress = await getProgramDataAddress(connection, PROJECT_ESCROW_PROGRAM_ID);

  const data = Buffer.alloc(8 + 8);
  anchorDiscriminator("set_vote_weight").copy(data, 0);
  data.writeBigUInt64LE(totalVoteWeightU64, 8);

  const ix = new TransactionInstruction({
    programId: PROJECT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: projectPda, isSigner: false, isWritable: true },
      { pubkey: voteWeightPda, isSigner: false, isWritable: true },
      { pubkey: PROJECT_ESCROW_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programDataAddress, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  console.log("Sending set_vote_weight...");
  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("Signature:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("Vote weight backfill done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
