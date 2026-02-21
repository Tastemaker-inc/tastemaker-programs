/**
 * One-off script: set Metaplex metadata (name, symbol, uri) on an existing RWA mint
 * so wallets and marketplaces show project title, description, and cover image.
 *
 * Usage:
 *   cd tastemaker-programs
 *   SOLANA_KEYPAIR=~/.config/solana/id.json BASE_URL=https://tastemaker.music npx ts-node scripts/initialize-rwa-metadata.ts <PROJECT_PDA>
 *
 * Authority must be rwa_state.authority (the project artist for governance-inited mints).
 *
 * Env:
 * - SOLANA_RPC_URL or ANCHOR_PROVIDER_URL: RPC (default devnet)
 * - SOLANA_KEYPAIR: keypair for authority (must match rwa_state.authority)
 * - PROJECT_PDA: project PDA (base58) if not passed as first arg
 * - BASE_URL: base URL for the app (uri will be BASE_URL/api/rwa-metadata?project=...); must yield uri length <= 200
 * - RWA_TOKEN_PROGRAM_ID: override (default from idl)
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

const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const MAX_NAME_LEN = 32;
const MAX_SYMBOL_LEN = 10;
const MAX_URI_LEN = 200;

function loadKeypair(): Keypair {
  const keypairPath = process.env.SOLANA_KEYPAIR ?? path.join(process.env.HOME ?? require("os").homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getProjectPda(): PublicKey {
  const raw = process.env.PROJECT_PDA ?? process.argv[2];
  if (!raw || typeof raw !== "string") {
    console.error("Usage: npx ts-node scripts/initialize-rwa-metadata.ts <PROJECT_PDA>");
    console.error("   or set PROJECT_PDA=<base58>");
    process.exit(1);
  }
  try {
    return new PublicKey(raw);
  } catch {
    console.error("Invalid PROJECT_PDA (base58 required):", raw);
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

function getMetadataGuardPda(programId: PublicKey, project: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_metadata"), project.toBuffer()],
    programId
  );
  return pda;
}

function getMetaplexMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA_ID
  );
  return pda;
}

async function main() {
  const authority = loadKeypair();
  const projectPda = getProjectPda();
  const baseUrl = (process.env.BASE_URL ?? "https://tastemaker.music").replace(/\/$/, "");
  const connection = new Connection(RPC, "confirmed");

  const idlPath = path.join(__dirname, "..", "target", "idl", "rwa_token.json");
  const fallbackIdlPath = path.join(__dirname, "..", "idl", "rwa_token.json");
  const resolvedIdlPath = fs.existsSync(idlPath) ? idlPath : fallbackIdlPath;
  const idl = JSON.parse(fs.readFileSync(resolvedIdlPath, "utf8"));
  const programId = process.env.RWA_TOKEN_PROGRAM_ID
    ? new PublicKey(process.env.RWA_TOKEN_PROGRAM_ID)
    : new PublicKey(idl.address);

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const program = new Program({ ...idl, address: programId.toBase58() }, provider);

  const rwaStatePda = getRwaStatePda(programId, projectPda);
  const rwaMintPda = getRwaMintPda(programId, projectPda);
  const rwaMintAuthorityPda = getRwaMintAuthorityPda(programId, projectPda);
  const metadataGuardPda = getMetadataGuardPda(programId, projectPda);
  const metadataPda = getMetaplexMetadataPda(rwaMintPda);

  const guardExists = await connection.getAccountInfo(metadataGuardPda, "confirmed");
  if (guardExists) {
    console.log("RWA metadata already set for this project. Nothing to do.");
    process.exit(0);
    return;
  }

  const uri = `${baseUrl}/api/rwa-metadata?project=${projectPda.toBase58()}`;
  if (uri.length > MAX_URI_LEN) {
    console.error("URI length", uri.length, "exceeds program limit", MAX_URI_LEN, ". Use a shorter BASE_URL.");
    process.exit(1);
  }

  let name = "Ownership Share";
  let symbol = "RWA";
  try {
    const res = await fetch(uri);
    if (res.ok) {
      const json = (await res.json()) as { name?: string; symbol?: string };
      if (typeof json.name === "string") {
        name = json.name.length > MAX_NAME_LEN ? json.name.slice(0, MAX_NAME_LEN - 3) + "..." : json.name;
      }
      if (typeof json.symbol === "string") {
        symbol = json.symbol.length > MAX_SYMBOL_LEN ? json.symbol.slice(0, MAX_SYMBOL_LEN) : json.symbol;
      }
    }
  } catch (e) {
    console.warn("Could not fetch metadata from API, using defaults:", (e as Error).message);
  }

  const methods = program.methods as { initializeRwaMetadata?: (n: string, s: string, u: string) => { accounts: (a: object) => { transaction: () => Promise<anchor.web3.Transaction> } } };
  if (typeof methods.initializeRwaMetadata !== "function") {
    console.error("Program IDL has no initializeRwaMetadata. Run anchor build and ensure rwa_token includes initialize_rwa_metadata.");
    process.exit(1);
  }

  const tx = await methods
    .initializeRwaMetadata(name, symbol, uri)
    .accounts({
      authority: authority.publicKey,
      rwaState: rwaStatePda,
      rwaMint: rwaMintPda,
      rwaMintAuthority: rwaMintAuthorityPda,
      metadataGuard: metadataGuardPda,
      metadata: metadataPda,
      tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
      systemProgram: SystemProgram.programId,
      sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .transaction();

  const sig = await connection.sendTransaction(tx, [authority], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log("Signature:", sig);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("RWA metadata initialized. Wallets will show name, description, and image from", uri);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
