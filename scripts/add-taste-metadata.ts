/**
 * One-time script: add Metaplex Token Metadata to the existing $TASTE mint on devnet.
 * So Phantom and other wallets show "$TASTE" / "TASTE" instead of "Unknown".
 *
 * Run from tastemaker-programs: npm run add-taste-metadata
 * Requires: $TASTE mint already initialized (run init-taste-mint first), devnet deploy wallet with SOL.
 * Keypair: same as init-taste-mint (~/.config/solana/devnet-deploy.json or SOLANA_KEYPAIR).
 *
 * Optional: TASTE_METADATA_URI = URL to a JSON with name, symbol, description, image.
 * Default: https://tastemaker.music/meta/taste.json (set when site is deployed, or override).
 */

import {
  createV1,
  mplTokenMetadata,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  keypairIdentity,
  percentAmount,
  publicKey,
} from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";
import * as fs from "fs";
import * as path from "path";

const TASTE_TOKEN_PROGRAM_ID = "2c6qsaK5o1mjUxSvJmfCDzfCcaim8c9hEmNZrBbc4Bxo";
const RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.ANCHOR_PROVIDER_URL ??
  "https://api.devnet.solana.com";

const DEFAULT_DEVNET_DEPLOY_KEYPAIR = path.join(
  process.env.HOME ?? require("os").homedir(),
  ".config/solana/devnet-deploy.json"
);

const DEFAULT_TASTE_METADATA_URI =
  "https://tastemaker.music/meta/taste.json";

function getTasteMintPda(): string {
  const { PublicKey } = require("@solana/web3.js");
  const programId = new PublicKey(TASTE_TOKEN_PROGRAM_ID);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("taste_mint")],
    programId
  );
  return pda.toBase58();
}

async function main() {
  const keypairPath =
    process.env.SOLANA_KEYPAIR ?? DEFAULT_DEVNET_DEPLOY_KEYPAIR;
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const secretKey = new Uint8Array(secret);

  const umi = createUmi(RPC).use(mplTokenMetadata());
  const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
  umi.use(keypairIdentity(keypair));

  const mintAddress = getTasteMintPda();
  const uri =
    process.env.TASTE_METADATA_URI?.trim() || DEFAULT_TASTE_METADATA_URI;

  console.log("Adding Metaplex Token Metadata for $TASTE on devnet...");
  console.log("Mint:", mintAddress);
  console.log("Metadata URI:", uri);
  console.log("Authority:", umi.identity.publicKey);

  const tx = await createV1(umi, {
    mint: publicKey(mintAddress),
    authority: umi.identity,
    payer: umi.identity,
    updateAuthority: umi.identity,
    name: "$TASTE",
    symbol: "TASTE",
    uri,
    sellerFeeBasisPoints: percentAmount(0),
    tokenStandard: TokenStandard.Fungible,
  }).sendAndConfirm(umi);

  const sig = base58.deserialize(tx.signature)[0];
  console.log("Done. Transaction:", sig);
  console.log(
    `https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
