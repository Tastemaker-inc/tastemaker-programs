/**
 * One-time script: initialize the $TASTE mint and treasury on devnet.
 * Run from tastemaker-programs: npm run init-taste-mint
 * Requires: anchor build (for idl), devnet deploy wallet with SOL.
 *
 * Keypair: Use devnet deploy keypair per .cursor/rules/devnet-deploy-upgrade.mdc.
 * Default: ~/.config/solana/devnet-deploy.json. Override with SOLANA_KEYPAIR.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const DEVNET_TASTE_TOKEN = "2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo";
const LOCALNET_TASTE_TOKEN = "ERm6fSLrTxCBB7FtF6EnVWFrgCi3qvBZPuhMKxJczrfk";
const RPC =
  process.env.SOLANA_RPC_URL ?? process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const isLocal = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const TASTE_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.TASTE_TOKEN_PROGRAM_ID ??
    (isLocal ? LOCALNET_TASTE_TOKEN : DEVNET_TASTE_TOKEN)
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

async function main() {
  const keypair = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "idl", "taste_token.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = TASTE_TOKEN_PROGRAM_ID;
  const program = new Program({ ...idl, address: programId.toBase58() }, provider);

  const [mintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("taste_mint")],
    TASTE_TOKEN_PROGRAM_ID
  );
  const [treasuryAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    TASTE_TOKEN_PROGRAM_ID
  );
  const treasuryAta = getAssociatedTokenAddressSync(
    mintPda,
    treasuryAuthPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  const mintInfo = await connection.getAccountInfo(mintPda);
  if (mintInfo) {
    console.log("$TASTE mint already initialized at", mintPda.toBase58());
    process.exit(0);
    return;
  }

  console.log("Initializing $TASTE mint and treasury on devnet...");
  console.log("Mint PDA:", mintPda.toBase58());
  console.log("Treasury authority:", treasuryAuthPda.toBase58());
  console.log("Treasury ATA:", treasuryAta.toBase58());

  await program.methods
    .initializeMint()
    .accounts({
      mintAuthority: keypair.publicKey,
      mint: mintPda,
      treasuryAuthority: treasuryAuthPda,
      treasury: treasuryAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Done. $TASTE mint is initialized at", mintPda.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
