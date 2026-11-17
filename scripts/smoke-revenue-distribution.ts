/**
 * Devnet smoke test for the upgraded revenue_distribution program (read-only by default).
 *
 * 1. Fetches every account the program owns and decodes it with idl/revenue_distribution.json
 *    (RevenueConfig, DistributionEpoch, HolderClaim).
 * 2. SIMULATES close_epoch on a DistributionEpoch that is not fully claimed. The upgraded program
 *    (b1476de) must fail with EpochNotFullyClaimed (6010); the March binary swept the remainder
 *    to the artist and succeeded. Simulation uses simulateTransaction with the signature
 *    verification off, so NO signature is made, nothing is sent and no state changes.
 *
 * Usage:
 *   ts-node scripts/smoke-revenue-distribution.ts [RPC_URL] [--epoch <EPOCH_PDA>] [--send <KEYPAIR_PATH>]
 *
 * - RPC_URL defaults to SOLANA_RPC_URL, then https://api.devnet.solana.com.
 * - Default mode needs no key at all (the artist_authority public key is read from the config).
 * - --send <KEYPAIR_PATH> is NOT needed for the smoke test. It would read that keypair file and SEND
 *   close_epoch, which on an epoch that passes the guard CLOSES the epoch account. Only the owner
 *   adds it, on purpose.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BorshAccountsCoder, Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey(
  process.env.REVENUE_DISTRIBUTION_PROGRAM_ID ?? "C7qE7zNk7YA9rLhqRejFpMPH9y2Ds8rYZs2WEyhxUUWK"
);
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const EPOCH_NOT_FULLY_CLAIMED = 6010;

const args = process.argv.slice(2);
function takeFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const epochArg = takeFlag("--epoch");
const sendKeypairPath = takeFlag("--send");
const RPC =
  args[0] ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "idl", "revenue_distribution.json"), "utf8")
) as Idl & { accounts: { name: string; discriminator: number[] }[]; instructions: any[] };
const coder = new BorshAccountsCoder(idl);

function accountName(data: Buffer): string | null {
  for (const a of idl.accounts) {
    if (Buffer.from(a.discriminator).equals(data.subarray(0, 8))) return a.name;
  }
  return null;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  console.log("RPC:", RPC, "program:", PROGRAM_ID.toBase58());

  // ---- Check 1: decode every program-owned account with the current IDL ----
  const owned = await connection.getProgramAccounts(PROGRAM_ID);
  const decoded: { pubkey: PublicKey; name: string; data: any }[] = [];
  let failures = 0;
  for (const { pubkey, account } of owned) {
    const name = accountName(account.data);
    if (!name) {
      console.log("UNKNOWN account type:", pubkey.toBase58(), "size", account.data.length);
      failures++;
      continue;
    }
    try {
      const data = coder.decode(name, account.data);
      decoded.push({ pubkey, name, data });
      console.log(`decoded ${name} ${pubkey.toBase58()} (${account.data.length} bytes)`);
    } catch (e) {
      console.log("DECODE FAILED:", name, pubkey.toBase58(), (e as Error).message);
      failures++;
    }
  }
  console.log(`check 1: ${decoded.length} of ${owned.length} accounts decoded, ${failures} failures`);

  // ---- Check 2: simulate close_epoch on an epoch that is not fully claimed ----
  const epochs = decoded.filter(
    (d) => d.name === "DistributionEpoch" && (!epochArg || d.pubkey.toBase58() === epochArg)
  );
  const target = epochs.find((e) => {
    const remaining = BigInt(e.data.amount.toString()) - BigInt(e.data.total_claimed.toString());
    const dust = BigInt(e.data.claimed_count.toString()) || 1n;
    return remaining > dust; // the new guard must reject it
  });
  if (!target) {
    console.log("check 2: no not-fully-claimed epoch found; nothing to simulate.");
    return;
  }
  const config = decoded.find(
    (d) => d.name === "RevenueConfig" && d.data.project.equals(target.data.project)
  );
  if (!config) throw new Error("No RevenueConfig for the epoch's project");

  const project: PublicKey = config.data.project;
  const authority: PublicKey = config.data.artist_authority; // the only signer close_epoch accepts
  const tasteMint: PublicKey = config.data.taste_mint;
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("rev_vault"), project.toBuffer()],
    PROGRAM_ID
  );
  const mintInfo = await connection.getAccountInfo(tasteMint);
  if (!mintInfo) throw new Error("taste_mint not found");
  const tokenProgram = mintInfo.owner;
  const revVault = getAssociatedTokenAddressSync(tasteMint, vaultAuthority, true, tokenProgram);
  let artistDest = getAssociatedTokenAddressSync(tasteMint, authority, false, tokenProgram);
  if (!(await connection.getAccountInfo(artistDest))) {
    // Simulation only needs some token account of this mint; nothing is transferred.
    artistDest = revVault;
    console.log("note: the artist's token account does not exist; using the vault as artist_dest");
  }

  const ixDef = idl.instructions.find((i) => i.name === "close_epoch");
  if (!ixDef) throw new Error("close_epoch not in IDL");
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.from(ixDef.discriminator),
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: config.pubkey, isSigner: false, isWritable: false },
      { pubkey: target.pubkey, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: revVault, isSigner: false, isWritable: true },
      { pubkey: artistDest, isSigner: false, isWritable: true },
      { pubkey: tasteMint, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message); // unsigned

  if (!sendKeypairPath) {
    const sim = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    console.log("simulation err:", JSON.stringify(sim.value.err));
    for (const l of sim.value.logs ?? []) console.log("  log:", l);
    const err: any = sim.value.err;
    const code = err?.InstructionError?.[1]?.Custom;
    if (code === EPOCH_NOT_FULLY_CLAIMED) {
      console.log("check 2: PASS - close_epoch rejected with EpochNotFullyClaimed (6010): new code is live.");
    } else if (sim.value.err === null) {
      console.log("check 2: FAIL - close_epoch would SUCCEED on a not-fully-claimed epoch (old behaviour).");
      process.exitCode = 2;
    } else {
      console.log("check 2: NOT SETTLED - failed for another reason (see err and logs above).");
      process.exitCode = 3;
    }
    return;
  }

  // Explicit, owner-only: sign with the given keypair and send. Not part of the smoke test.
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(sendKeypairPath, "utf8")))
  );
  if (!kp.publicKey.equals(authority)) {
    throw new Error(`Keypair ${kp.publicKey.toBase58()} is not the artist_authority ${authority.toBase58()}`);
  }
  tx.sign([kp]);
  const sig = await connection.sendTransaction(tx);
  console.log("sent close_epoch:", sig);
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message ?? e);
  process.exit(1);
});
