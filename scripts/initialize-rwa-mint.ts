/**
 * One-off script: initialize RWA mint for a completed project that finished before
 * the governance+RWA upgrade (so finalize_proposal never ran the RWA CPI).
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_KEYPAIR=~/.config/solana/devnet-deploy.json npx ts-node scripts/initialize-rwa-mint.ts <PROJECT_PDA>
 *
 * Or with env:
 *   PROJECT_PDA=<base58_project_pda> npm run initialize-rwa-mint
 *
 * Env:
 * - SOLANA_RPC_URL or ANCHOR_PROVIDER_URL: RPC (default devnet)
 * - SOLANA_KEYPAIR: keypair that will sign (payer/authority; program does not require artist)
 * - PROJECT_PDA: project PDA (base58) if not passed as first arg
 * - RWA_TOKEN_PROGRAM_ID: override (default from idl)
 *
 * Total supply is fixed at 1_000_000 * 1_000_000 (same as governance CPI).
 *
 * Prerequisite: initialize_rwa_config must have been called once (by upgrade authority)
 * to set the transfer hook program ID. Run init-rwa-config.ts first if needed.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.ANCHOR_PROVIDER_URL ??
  "https://api.devnet.solana.com";

const RWA_TOTAL_SUPPLY = 1_000_000 * 1_000_000; // 1e12 (6 decimals → 1_000_000 tokens)

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
    console.error("Usage: npx ts-node scripts/initialize-rwa-mint.ts <PROJECT_PDA>");
    console.error("   or set PROJECT_PDA=<base58>");
    process.exit(1);
  }
  try {
    return new PublicKey(raw);
  } catch {
    console.error("Invalid PROJECT_PDA (must be base58):", raw);
    process.exit(1);
  }
}

function getRwaStatePda(programId: PublicKey, project: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_state"), project.toBuffer()],
    programId
  );
  return pda;
}

function getRwaMintPda(programId: PublicKey, project: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_mint"), project.toBuffer()],
    programId
  );
  return pda;
}

function getRwaMintAuthorityPda(programId: PublicKey, project: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_mint_authority"), project.toBuffer()],
    programId
  );
  return pda;
}

const RWA_TRANSFER_HOOK_PROGRAM_ID = new PublicKey("56LtERCqfVTv84E2AtL3jrKBdFXD8QxQN74NmoyJjBPn");

function getRwaConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_config")],
    programId
  )[0];
}

function getRwaExtraAccountMetasPda(rwaMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), rwaMint.toBuffer()],
    RWA_TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

async function main() {
  const authority = loadKeypair();
  const projectPda = getProjectPda();
  const connection = new Connection(RPC, "confirmed");

  const idlPath = path.join(__dirname, "..", "idl", "rwa_token.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = process.env.RWA_TOKEN_PROGRAM_ID
    ? new PublicKey(process.env.RWA_TOKEN_PROGRAM_ID)
    : new PublicKey(idl.address);

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program({ ...idl, address: programId.toBase58() }, provider);

  const rwaStatePda = getRwaStatePda(programId, projectPda);
  const rwaMintPda = getRwaMintPda(programId, projectPda);
  const rwaMintAuthorityPda = getRwaMintAuthorityPda(programId, projectPda);

  const existing = await connection.getAccountInfo(rwaStatePda, "confirmed");
  if (existing) {
    console.log("RWA state already exists for this project. Nothing to do.");
    process.exit(0);
    return;
  }

  console.log("RPC:", RPC);
  console.log("Project PDA:", projectPda.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("RWA program:", programId.toBase58());
  console.log("Total supply:", RWA_TOTAL_SUPPLY);

  const rwaConfigPda = getRwaConfigPda(programId);
  const rwaExtraAccountMetasPda = getRwaExtraAccountMetasPda(rwaMintPda);

  const tx = await (program.methods as any)
    .initializeRwaMint(new anchor.BN(RWA_TOTAL_SUPPLY))
    .accounts({
      authority: authority.publicKey,
      project: projectPda,
      rwaState: rwaStatePda,
      rwaConfig: rwaConfigPda,
      rwaMint: rwaMintPda,
      rwaMintAuthority: rwaMintAuthorityPda,
      rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetas: rwaExtraAccountMetasPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const sig = await connection.sendTransaction(tx, [authority], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("Signature:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("RWA mint initialized. Backers can now claim ownership shares.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
