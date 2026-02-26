/**
 * One-time script: initialize rwa_token RwaConfig PDA with the transfer hook program ID.
 *
 * Required before any project can complete (finalize last milestone). When the last milestone
 * is finalized, governance CPIs rwa_token::initialize_rwa_mint_by_governance, which requires
 * RwaConfig to exist. Only the rwa_token program upgrade authority can call this.
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npm run init-rwa-config
 *
 * Env:
 * - SOLANA_RPC_URL or ANCHOR_PROVIDER_URL: RPC endpoint (default devnet)
 * - SOLANA_KEYPAIR: upgrade authority keypair (defaults to ~/.config/solana/devnet-deploy.json)
 * - RWA_TOKEN_PROGRAM_ID: override (default devnet GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE)
 * - RWA_TRANSFER_HOOK_PROGRAM_ID: override (default devnet HAC2Q2ecWgDXHt34bs1afuGqUsKfxycqd2MXuWHkRgRj)
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

const RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.ANCHOR_PROVIDER_URL ??
  "https://api.devnet.solana.com";

const DEFAULT_RWA_TOKEN_PROGRAM_ID = "GqSR1FPPjaTH4hzjm5kpejh3dUdTQtdufaz1scU5ZkvE";
const DEFAULT_RWA_TRANSFER_HOOK_PROGRAM_ID =
  "HAC2Q2ecWgDXHt34bs1afuGqUsKfxycqd2MXuWHkRgRj";

const RWA_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.RWA_TOKEN_PROGRAM_ID ?? DEFAULT_RWA_TOKEN_PROGRAM_ID
);
const RWA_TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  process.env.RWA_TRANSFER_HOOK_PROGRAM_ID ?? DEFAULT_RWA_TRANSFER_HOOK_PROGRAM_ID
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

/** Anchor discriminator for initialize_rwa_config (from idl). */
const INIT_RWA_CONFIG_DISCRIMINATOR = Buffer.from([
  165, 125, 131, 8, 200, 122, 181, 132,
]);

async function getProgramDataAddress(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey> {
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (!programInfo) {
    throw new Error(
      `Program not found: ${programId.toBase58()}. Check cluster and RWA_TOKEN_PROGRAM_ID.`
    );
  }
  if (!programInfo.executable || programInfo.data.length < 36) {
    throw new Error(`Invalid program account: ${programId.toBase58()}`);
  }
  const disc = programInfo.data.readUInt32LE(0);
  if (disc !== 2) throw new Error("Expected upgradeable program (disc 2).");
  return new PublicKey(programInfo.data.subarray(4, 36));
}

function getRwaConfigPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_config")],
    programId
  );
  return pda;
}

async function main() {
  const authority = loadKeypair();
  const connection = new Connection(RPC, "confirmed");

  const rwaConfigPda = getRwaConfigPda(RWA_TOKEN_PROGRAM_ID);
  const programDataAddress = await getProgramDataAddress(
    connection,
    RWA_TOKEN_PROGRAM_ID
  );

  console.log("RPC:", RPC);
  console.log("rwa_token program:", RWA_TOKEN_PROGRAM_ID.toBase58());
  console.log("rwa_transfer_hook program:", RWA_TRANSFER_HOOK_PROGRAM_ID.toBase58());
  console.log("Upgrade authority signer:", authority.publicKey.toBase58());
  console.log("RwaConfig PDA:", rwaConfigPda.toBase58());

  const existing = await connection.getAccountInfo(rwaConfigPda, "confirmed");
  if (existing) {
    console.log("RwaConfig already initialized. No action needed.");
    process.exit(0);
    return;
  }

  const data = Buffer.concat([
    INIT_RWA_CONFIG_DISCRIMINATOR,
    RWA_TRANSFER_HOOK_PROGRAM_ID.toBuffer(),
  ]);
  const keys = [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: rwaConfigPda, isSigner: false, isWritable: true },
    { pubkey: RWA_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: programDataAddress, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const ix = new TransactionInstruction({
    programId: RWA_TOKEN_PROGRAM_ID,
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await connection.sendTransaction(tx, [authority], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("Transaction sent:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("RwaConfig initialized. You can now finalize the last milestone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
