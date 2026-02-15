/**
 * One-time script: initialize governance Config PDA (allow_early_finalize, min_voting_period_secs).
 *
 * Only the program upgrade authority can call this. Use on devnet to enable early finalize and short voting periods.
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npm run init-governance-config
 *
 * Env:
 * - SOLANA_RPC_URL or ANCHOR_PROVIDER_URL: RPC endpoint
 * - SOLANA_KEYPAIR: upgrade authority keypair
 * - GOVERNANCE_PROGRAM_ID: override (defaults to devnet id)
 * - MIN_VOTING_PERIOD_SECS: min period for new proposals (default 60)
 * - ALLOW_NON_DEVNET=1: allow running on non-devnet (e.g. mainnet) when cluster guard is enabled
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

const DEFAULT_GOVERNANCE_PROGRAM_ID = "AGP7BofJoJco4wTR6jaM1mf28z2UuV6Xj9aN4RBY9gnK";
const GOVERNANCE_PROGRAM_ID = new PublicKey(
  process.env.GOVERNANCE_PROGRAM_ID ?? DEFAULT_GOVERNANCE_PROGRAM_ID
);

const MIN_VOTING_PERIOD_SECS = (() => {
  const s = process.env.MIN_VOTING_PERIOD_SECS ?? "60";
  const n = parseInt(s, 10);
  return Number.isNaN(n) || n < 1 ? 60 : n;
})();

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
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

async function getProgramDataAddress(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey> {
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (!programInfo) {
    throw new Error(
      `Program not found: ${programId.toBase58()}. Check cluster and GOVERNANCE_PROGRAM_ID.`
    );
  }
  if (!programInfo.executable || programInfo.data.length < 36) {
    throw new Error(`Invalid program account: ${programId.toBase58()}`);
  }
  const disc = programInfo.data.readUInt32LE(0);
  if (disc !== 2) throw new Error("Expected upgradeable program (disc 2).");
  return new PublicKey(programInfo.data.subarray(4, 36));
}

/** Devnet genesis hash allowlist; used to enforce cluster guard unless ALLOW_NON_DEVNET=1. */
const DEVNET_GENESIS_HASHES = new Set([
  // Commonly observed values from Solana docs/providers over time.
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC",
]);

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");

  const genesisHash = await connection.getGenesisHash();
  if (!DEVNET_GENESIS_HASHES.has(genesisHash)) {
    if (process.env.ALLOW_NON_DEVNET !== "1") {
      console.error(
        "This script is intended for devnet. Current cluster genesis hash:",
        genesisHash,
        "\nSet ALLOW_NON_DEVNET=1 to run on a different cluster."
      );
      process.exit(1);
    }
  }

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    GOVERNANCE_PROGRAM_ID
  );

  console.log("RPC:", RPC);
  console.log("Governance program:", GOVERNANCE_PROGRAM_ID.toBase58());
  console.log("Upgrade authority:", payer.publicKey.toBase58());
  console.log("Config PDA:", configPda.toBase58());
  console.log("allow_early_finalize: true, min_voting_period_secs:", MIN_VOTING_PERIOD_SECS);

  const existing = await connection.getAccountInfo(configPda, "confirmed");
  if (existing) {
    console.log("Config already exists. Skip.");
    process.exit(0);
    return;
  }

  const programDataAddress = await getProgramDataAddress(connection, GOVERNANCE_PROGRAM_ID);
  console.log("ProgramData:", programDataAddress.toBase58());

  const allowEarlyFinalize = true;
  const data = Buffer.alloc(8 + 1 + 8);
  anchorDiscriminator("initialize_config").copy(data, 0);
  data.writeUInt8(allowEarlyFinalize ? 1 : 0, 8);
  data.writeBigInt64LE(BigInt(MIN_VOTING_PERIOD_SECS), 9);

  const ix = new TransactionInstruction({
    programId: GOVERNANCE_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: GOVERNANCE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programDataAddress, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  console.log("Sending initialize_config...");
  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("Signature:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("Governance config initialized.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
