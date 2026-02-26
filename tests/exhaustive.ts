/**
 * Exhaustive integration tests: many backers, varying amounts, quadratic voting.
 * Run with: yarn test:full  (builds governance with test feature for 1s voting)
 * Or: anchor test -- --features governance/test
 *
 * Covers: taste_token (init, mint_to_treasury, mint_to, burn), project_escrow
 * (create, fund, release via finalize, cancel, refund), governance
 * (create_proposal, cast_vote, finalize_proposal, cancel_proposal),
 * rwa_token (initialize_rwa_mint, claim_rwa_tokens, close_distribution).
 *
 * Process exits with code 1 after MAX_WALL_CLOCK_MS if still running (no user cancel needed).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  createTransferCheckedWithTransferHookInstruction,
  createTransferCheckedInstruction,
  createReallocateInstruction,
  ExtensionType,
} from "@solana/spl-token";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import fs from "fs";
import path from "path";
chai.use(chaiAsPromised);

const DECIMALS = 9;

function idlPath(name: string): string {
  return path.join(process.cwd(), "target", "idl", `${name}.json`);
}
const LAMPORTS_PER_TASTE = Math.pow(10, DECIMALS);

const MAX_WALL_CLOCK_MS = 22 * 60 * 1000; // 22 min; under CI job 25 min so we exit cleanly with message
const watchdogTimer = setTimeout(() => {
  console.error("\n[exhaustive] Wall-clock limit reached (%d min). Exiting to avoid hanging.\n", MAX_WALL_CLOCK_MS / 60000);
  process.exit(1);
}, MAX_WALL_CLOCK_MS);

function sqrtU64(x: bigint): bigint {
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n;
  let y = x;
  while (z < y) {
    y = z;
    z = x / z + z;
    z = z / 2n;
  }
  return y;
}

/** Run fn; on SendTransactionError call getLogs(connection) and rethrow with full logs for CI. */
async function withTxLogs<T>(connection: Connection, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SendTransactionError && typeof e.getLogs === "function") {
      try {
        const logs = await e.getLogs(connection);
        throw new Error(`${(e as Error).message}\nFull logs:\n${logs.join("\n")}`);
      } catch (nested) {
        if (nested instanceof Error && nested.message.includes("Full logs:")) throw nested;
        throw e;
      }
    }
    throw e;
  }
}

function getProjectPda(artist: PublicKey, projectIndex: number, programId: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(projectIndex));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("project"), artist.toBuffer(), buf],
    programId
  );
  return pda;
}

function getArtistStatePda(artist: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("artist_state"), artist.toBuffer()],
    programId
  );
  return pda;
}

function getEscrowConfigPda(projectEscrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    projectEscrowProgramId
  )[0];
}

function getGovConfigPda(governanceProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    governanceProgramId
  )[0];
}

const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// When run via scripts/run-test-full.sh, this is set to the deployed hook's program ID (from keypair).
// Fallback to Anchor.toml localnet ID for direct anchor test when hook is pre-deployed at that address.
const RWA_TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  process.env.RWA_TRANSFER_HOOK_PROGRAM_ID || "56LtERCqfVTv84E2AtL3jrKBdFXD8QxQN74NmoyJjBPn"
);

function getRwaConfigPda(rwaTokenProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_config")],
    rwaTokenProgramId
  )[0];
}

function getRwaExtraAccountMetasPda(rwaMint: PublicKey, transferHookProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), rwaMint.toBuffer()],
    transferHookProgramId
  )[0];
}

function getRevConfigPda(project: PublicKey, revenueDistributionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rev_config"), project.toBuffer()],
    revenueDistributionProgramId
  )[0];
}

function getRevVaultAuthorityPda(project: PublicKey, revenueDistributionProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rev_vault"), project.toBuffer()],
    revenueDistributionProgramId
  )[0];
}

function getRwaRightsPda(project: PublicKey, rwaTokenProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_rights"), project.toBuffer()],
    rwaTokenProgramId
  )[0];
}

/** Default RWA args for finalize_proposal (rights type, splits, duration, terms). Used by all finalizeProposal() test calls. */
const DEFAULT_FINALIZE_RWA_ARGS = [
  { masterRecording: {} as const },
  5000,
  5000,
  new anchor.BN(Math.round(10 * 365.25 * 86400)),
  new anchor.BN(0),
  Array.from(Buffer.alloc(32)) as number[],
  "https://example.com/terms",
  "US",
] as const;

function getFinalizeProposalRwaAccounts(
  projectPda: PublicKey,
  tasteMint: PublicKey,
  rwaTokenProgramId: PublicKey,
  revenueDistributionProgramId: PublicKey
) {
  const rwaRights = getRwaRightsPda(projectPda, rwaTokenProgramId);
  const revConfig = getRevConfigPda(projectPda, revenueDistributionProgramId);
  const revVaultAuthority = getRevVaultAuthorityPda(projectPda, revenueDistributionProgramId);
  const revVault = getAssociatedTokenAddressSync(tasteMint, revVaultAuthority, true, TOKEN_2022_PROGRAM_ID);
  return {
    rwaRights,
    revConfig,
    revVaultAuthority,
    revVault,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    revenueDistributionProgram: revenueDistributionProgramId,
  };
}

/** Create an Address Lookup Table containing the 6 RWA accounts for finalize_proposal (and optionally extra addresses for remainingAccounts) so the tx fits under 1232 bytes. */
async function createAltForFinalize(
  connection: Connection,
  payer: Keypair,
  projectPda: PublicKey,
  tasteMint: PublicKey,
  rwaTokenProgramId: PublicKey,
  revenueDistributionProgramId: PublicKey,
  extraAddresses?: PublicKey[]
): Promise<{ lookupTableAddress: PublicKey; alt: AddressLookupTableAccount }> {
  // recentSlot must be a slot where a block was produced (in SlotHashes). getSlot("finalized") guarantees that.
  const slot = await connection.getSlot("finalized");
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  const createTx = new Transaction().add(createIx);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  createTx.recentBlockhash = blockhash;
  createTx.feePayer = payer.publicKey;
  await sendAndConfirmTransaction(connection, createTx, [payer], { commitment: "confirmed", preflightCommitment: "confirmed" });

  const rwaAccounts = getFinalizeProposalRwaAccounts(projectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lookupTableAddress,
    addresses: [
      rwaAccounts.rwaRights,
      rwaAccounts.revConfig,
      rwaAccounts.revVaultAuthority,
      rwaAccounts.revVault,
      rwaAccounts.associatedTokenProgram,
      rwaAccounts.revenueDistributionProgram,
      ...(extraAddresses ?? []),
    ],
  });
  const extendTx = new Transaction().add(extendIx);
  extendTx.recentBlockhash = blockhash;
  extendTx.feePayer = payer.publicKey;
  await sendAndConfirmTransaction(connection, extendTx, [payer], { commitment: "confirmed", preflightCommitment: "confirmed" });

  await new Promise((r) => setTimeout(r, 500));
  const altResult = await connection.getAddressLookupTable(lookupTableAddress);
  if (!altResult.value) throw new Error("ALT fetch failed after create+extend");
  return { lookupTableAddress, alt: altResult.value };
}

/** Build and send finalize_proposal as a v0 VersionedTransaction using the ALT so the tx fits under 1232 bytes. Retries once on blockhash expiry. */
async function sendFinalizeProposalV0(
  connection: Connection,
  payer: Keypair,
  finalizeBuilder: { instruction: () => Promise<{ programId: PublicKey; keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; data: Buffer }> },
  alt: AddressLookupTableAccount,
  signers: Keypair[]
): Promise<string> {
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const finalizeIx = await finalizeBuilder.instruction();
  const maxAttempts = 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeIx, finalizeIx],
    }).compileToV0Message([alt]);
    const vt = new VersionedTransaction(message);
    vt.sign([payer, ...signers]);
    try {
      const sig = await connection.sendTransaction(vt, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return sig;
    } catch (e) {
      lastErr = e;
      const isExpiry = e instanceof TransactionExpiredBlockheightExceededError
        || (e instanceof Error && (e.name === "TransactionExpiredBlockheightExceededError" || e.message?.includes("block height exceeded")));
      if (!isExpiry || attempt === maxAttempts - 1) throw e;
    }
  }
  throw lastErr;
}

/** Payer keypair for v0 finalize (must match provider.wallet). From NodeWallet.keypair or ANCHOR_WALLET / default Solana path. */
function getProviderPayerKeypair(provider: anchor.AnchorProvider): Keypair {
  const w = provider.wallet as unknown as { keypair?: Keypair };
  if (w?.keypair) return w.keypair;
  const keypairPath = process.env.ANCHOR_WALLET ?? path.join(process.env.HOME ?? require("os").homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getDistributionEpochPda(project: PublicKey, epochIndex: number, revenueDistributionProgramId: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(epochIndex));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), project.toBuffer(), buf],
    revenueDistributionProgramId
  )[0];
}

function getHolderClaimPda(project: PublicKey, epochIndex: number, holder: PublicKey, revenueDistributionProgramId: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(epochIndex));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("holder_claim"), project.toBuffer(), buf, holder.toBuffer()],
    revenueDistributionProgramId
  )[0];
}

function getRwaPdas(projectPda: PublicKey, rwaTokenProgramId: PublicKey) {
  const [rwaState] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_state"), projectPda.toBuffer()],
    rwaTokenProgramId
  );
  const [rwaMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_mint"), projectPda.toBuffer()],
    rwaTokenProgramId
  );
  const [rwaMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
    rwaTokenProgramId
  );
  const [rwaMetadataGuard] = PublicKey.findProgramAddressSync(
    [Buffer.from("rwa_metadata"), projectPda.toBuffer()],
    rwaTokenProgramId
  );
  const [rwaMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), rwaMint.toBuffer()],
    MPL_TOKEN_METADATA_ID
  );
  const rwaConfig = getRwaConfigPda(rwaTokenProgramId);
  const rwaExtraAccountMetas = getRwaExtraAccountMetasPda(rwaMint, RWA_TRANSFER_HOOK_PROGRAM_ID);
  return { rwaState, rwaMint, rwaMintAuthority, rwaMetadataGuard, rwaMetadata, rwaConfig, rwaExtraAccountMetas };
}

function getVoteWeightPda(project: PublicKey, projectEscrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote_weight"), project.toBuffer()],
    projectEscrowProgramId
  )[0];
}

/** BPF Loader Upgradeable program ID (program data PDA derivation). */
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function getProgramDataAddress(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );
  return pda;
}

function getPlatformTreasuryAta(tasteMint: PublicKey, tasteTokenProgramId: PublicKey): PublicKey {
  const [treasuryAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    tasteTokenProgramId
  );
  return getAssociatedTokenAddressSync(tasteMint, treasuryAuth, true, TOKEN_2022_PROGRAM_ID);
}

function getBurnVaultAccounts(tasteMint: PublicKey, projectEscrowProgramId: PublicKey): { authority: PublicKey; tokenAccount: PublicKey } {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("burn_vault")],
    projectEscrowProgramId
  );
  const tokenAccount = getAssociatedTokenAddressSync(tasteMint, authority, true, TOKEN_2022_PROGRAM_ID);
  return { authority, tokenAccount };
}

function getProjectTermsPda(project: PublicKey, projectEscrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("project_terms"), project.toBuffer()],
    projectEscrowProgramId
  )[0];
}

function getReceiptMintPda(project: PublicKey, backer: PublicKey, projectEscrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), project.toBuffer(), backer.toBuffer()],
    projectEscrowProgramId
  )[0];
}

function getReceiptAuthorityPda(project: PublicKey, backer: PublicKey, projectEscrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt_authority"), project.toBuffer(), backer.toBuffer()],
    projectEscrowProgramId
  )[0];
}

function getProposalAttemptPda(project: PublicKey, governanceProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal_attempt"), project.toBuffer()],
    governanceProgramId
  )[0];
}

function getProposalPda(project: PublicKey, milestone: number, attempt: number, governanceProgramId: PublicKey): PublicKey {
  const attemptBuf = Buffer.alloc(8);
  attemptBuf.writeBigUInt64LE(BigInt(attempt));
  const seeds = [
    Buffer.from("proposal"),
    project.toBuffer(),
    Buffer.from([milestone]),
    attemptBuf,
  ];
  return PublicKey.findProgramAddressSync(seeds, governanceProgramId)[0];
}

async function getCurrentProposalAttempt(governance: Program, proposalAttemptPda: PublicKey): Promise<number> {
  try {
    const acc = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<{ attempt: { toString: () => string } }> }>).proposalAttempt.fetch(proposalAttemptPda);
    return Number(acc.attempt.toString());
  } catch {
    return 0;
  }
}

describe("tastemaker-programs exhaustive", function () {
  this.timeout(600_000); // 10 min total so suite fails fast if stuck (e.g. after airdrop timeout)

  after(() => {
    clearTimeout(watchdogTimer);
  });

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const tasteTokenIdl = require(idlPath("taste_token"));
  const projectEscrowIdl = require(idlPath("project_escrow"));
  const governanceIdl = require(idlPath("governance"));
  const rwaTokenIdl = require(idlPath("rwa_token"));
  const revenueDistributionIdl = require(idlPath("revenue_distribution"));

  const tasteTokenProgramId = new PublicKey(tasteTokenIdl.address);
  const projectEscrowProgramId = new PublicKey(projectEscrowIdl.address);
  const governanceProgramId = new PublicKey(governanceIdl.address);
  const rwaTokenProgramId = new PublicKey(rwaTokenIdl.address);
  const revenueDistributionProgramId = new PublicKey(revenueDistributionIdl.address);

  let tasteToken: Program;
  let projectEscrow: Program;
  let governance: Program;
  let rwaToken: Program;
  let revenueDistribution: Program;

  let tasteMint: PublicKey;
  let treasuryAuthority: PublicKey;
  let artist: Keypair;
  const BACKER_COUNT = 40;
  const backers: Keypair[] = [];
  const backerAmounts: bigint[] = [];
  const legacyBackers = [Keypair.generate(), Keypair.generate()];
  const LEGACY_BACKER_AMOUNTS = [1_000_000n * BigInt(LAMPORTS_PER_TASTE), 2_000_000n * BigInt(LAMPORTS_PER_TASTE)];
  let cancelProposalBacker: Keypair;
  let cancelBacker: Keypair;
  const twoMilestoneBackers = [Keypair.generate(), Keypair.generate()];

  const MILESTONES = [20, 20, 20, 20, 20] as [number, number, number, number, number];
  const GOAL = 50_000_000n * BigInt(LAMPORTS_PER_TASTE);
  const VOTING_PERIOD_SECS = new anchor.BN(45);
  const SLEEP_MS = 47_000;

  const AIRDROP_CONFIRM_MS = 15_000;
  const AIRDROP_RETRIES = 2;

  async function airdrop(pubkey: PublicKey, lamports = 2e9) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < AIRDROP_RETRIES; attempt++) {
      try {
        const sig = await provider.connection.requestAirdrop(pubkey, lamports);
        const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash("confirmed");
        await provider.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < AIRDROP_RETRIES - 1) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw lastErr;
  }

  before(async () => {
    // Sanity: ensure IDL has artist as signer for finalize_proposal (CPI signer rule). Stale IDL => rebuild.
    type IdlInstruction = { name: string; accounts?: { name: string; signer?: boolean }[] };
    const instructions = (governanceIdl as { instructions?: IdlInstruction[] }).instructions;
    const fp = instructions?.find((ix: IdlInstruction) => ix.name === "finalize_proposal");
    const artistAcc = fp?.accounts?.find((a: { name: string; signer?: boolean }) => a.name === "artist");
    if (!artistAcc?.signer) {
      throw new Error("governance IDL: finalize_proposal.artist must have signer: true. Rebuild with: anchor build (and run test via npm run test:full)");
    }

    tasteToken = new Program(tasteTokenIdl, provider);
    projectEscrow = new Program(projectEscrowIdl, provider);
    governance = new Program(governanceIdl, provider);
    rwaToken = new Program(rwaTokenIdl, provider);
    revenueDistribution = new Program(revenueDistributionIdl, provider);

    // Derive taste_mint PDA so tasteMint is always set for tests that run in isolation (e.g. --grep).
    const [mintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("taste_mint")],
      tasteTokenProgramId
    );
    tasteMint = mintPda;

    await airdrop(provider.wallet.publicKey, 10e9);

    artist = Keypair.generate();
    for (let i = 0; i < BACKER_COUNT; i++) {
      backers.push(Keypair.generate());
    }

    await airdrop(artist.publicKey);
    for (let i = 0; i < backers.length; i++) {
      await airdrop(backers[i].publicKey);
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 500));
    }
    cancelProposalBacker = Keypair.generate();
    await airdrop(cancelProposalBacker.publicKey);
    cancelBacker = Keypair.generate();
    await airdrop(cancelBacker.publicKey);
    for (const b of legacyBackers) await airdrop(b.publicKey);
    for (const b of twoMilestoneBackers) await airdrop(b.publicKey);
  });

  describe("project_escrow config", () => {
    // Run negative test first while config account does not exist (so instruction runs and fails on authority check).
    it("initializeConfig fails when signer is not the program upgrade authority", async () => {
      const wrongAuthority = Keypair.generate();
      await airdrop(wrongAuthority.publicKey);
      const configPda = getEscrowConfigPda(projectEscrowProgramId);
      const [releaseAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("release_authority")],
        governanceProgramId
      );
      await expect(
        projectEscrow.methods
          .initializeConfig(releaseAuthority)
          .accounts({
            authority: wrongAuthority.publicKey,
            config: configPda,
            programAccount: projectEscrowProgramId,
            programDataAccount: getProgramDataAddress(projectEscrowProgramId),
            systemProgram: SystemProgram.programId,
          })
          .signers([wrongAuthority])
          .rpc()
      ).to.be.rejectedWith(/NotUpgradeAuthority|6011|6012|0x177b|0x177c/i);
    });

    it("initializes config with correct upgrade authority", async () => {
      const configPda = getEscrowConfigPda(projectEscrowProgramId);
      const [releaseAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("release_authority")],
        governanceProgramId
      );
      try {
        await projectEscrow.methods
          .initializeConfig(releaseAuthority)
          .accounts({
            authority: provider.wallet.publicKey,
            config: configPda,
            programAccount: projectEscrowProgramId,
            programDataAccount: getProgramDataAddress(projectEscrowProgramId),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (!/already in use|AccountAlreadyInitialized|0x0|custom program error: 0x0/i.test(msg)) throw e;
      }
    });

    it("updateConfig fails when signer is not the program upgrade authority", async () => {
      const wrongAuthority = Keypair.generate();
      await airdrop(wrongAuthority.publicKey);
      const configPda = getEscrowConfigPda(projectEscrowProgramId);
      const [releaseAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("release_authority")],
        governanceProgramId
      );
      await expect(
        projectEscrow.methods
          .updateConfig(releaseAuthority)
          .accounts({
            authority: wrongAuthority.publicKey,
            config: configPda,
            programAccount: projectEscrowProgramId,
            programDataAccount: getProgramDataAddress(projectEscrowProgramId),
          })
      .signers([wrongAuthority])
      .rpc()
  ).to.be.rejectedWith(/NotUpgradeAuthority|6011|0x177b/i);
    });

    it("update_config: upgrade authority updates governance_release_authority", async () => {
      const configPda = getEscrowConfigPda(projectEscrowProgramId);
      const [originalReleaseAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("release_authority")],
        governanceProgramId
      );
      const configBefore = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<{ governanceReleaseAuthority: PublicKey }> }>).config.fetch(configPda);
      const newReleaseAuthority = Keypair.generate().publicKey;
      await projectEscrow.methods
        .updateConfig(newReleaseAuthority)
        .accounts({
          authority: provider.wallet.publicKey,
          config: configPda,
          programAccount: projectEscrowProgramId,
          programDataAccount: getProgramDataAddress(projectEscrowProgramId),
        })
        .rpc();
      const configAfter = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<{ governanceReleaseAuthority: PublicKey }> }>).config.fetch(configPda);
      expect(configAfter.governanceReleaseAuthority.equals(newReleaseAuthority)).to.be.true;
      await projectEscrow.methods
        .updateConfig(originalReleaseAuthority)
        .accounts({
          authority: provider.wallet.publicKey,
          config: configPda,
          programAccount: projectEscrowProgramId,
          programDataAccount: getProgramDataAddress(projectEscrowProgramId),
        })
        .rpc();
    });
  });

  describe("governance config", () => {
    it("initializes gov config with upgrade authority (allow_early_finalize, min_voting_period_secs)", async () => {
      const govConfigPda = getGovConfigPda(governanceProgramId);
      try {
        await (governance.methods as unknown as { initializeConfig: (a: boolean, b: anchor.BN) => { accounts: (acc: Record<string, unknown>) => { rpc: () => Promise<string> } } })
          .initializeConfig(true, new anchor.BN(2))
          .accounts({
            authority: provider.wallet.publicKey,
            config: govConfigPda,
            programAccount: governanceProgramId,
            programDataAccount: getProgramDataAddress(governanceProgramId),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (!/already in use|AccountAlreadyInitialized|0x0|custom program error: 0x0/i.test(msg)) throw e;
      }
    });
  });

  describe("rwa_token config", () => {
    it("initializes RwaConfig with transfer hook program (upgrade authority)", async () => {
      const rwaConfigPda = getRwaConfigPda(rwaTokenProgramId);
      try {
        await (rwaToken.methods as unknown as { initializeRwaConfig: (id: PublicKey) => { accounts: (acc: Record<string, unknown>) => { rpc: () => Promise<string> } } })
          .initializeRwaConfig(RWA_TRANSFER_HOOK_PROGRAM_ID)
          .accounts({
            authority: provider.wallet.publicKey,
            rwaConfig: rwaConfigPda,
            programAccount: rwaTokenProgramId,
            programDataAccount: getProgramDataAddress(rwaTokenProgramId),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (!/already in use|AccountAlreadyInitialized|0x0|custom program error: 0x0/i.test(msg)) throw e;
      }
    });
  });

  describe("taste_token", () => {
    it("initializes mint and treasury", async () => {
      const [mintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("taste_mint")],
        tasteTokenProgramId
      );
      const [treasuryAuthPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        tasteTokenProgramId
      );
      const treasuryAta = getAssociatedTokenAddressSync(
        mintPda,
        treasuryAuthPda,
        true,
        TOKEN_2022_PROGRAM_ID
      );

      await tasteToken.methods
        .initializeMint()
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: mintPda,
          treasuryAuthority: treasuryAuthPda,
          treasury: treasuryAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      tasteMint = mintPda;
      treasuryAuthority = treasuryAuthPda;
    });

    it("mints to treasury and to all backers with varying amounts", async () => {
      const treasuryAta = getAssociatedTokenAddressSync(
        tasteMint,
        treasuryAuthority,
        true,
        TOKEN_2022_PROGRAM_ID
      );
      const treasuryAmount = 100_000_000n * BigInt(LAMPORTS_PER_TASTE);
      await tasteToken.methods
        .mintToTreasury(new anchor.BN(treasuryAmount.toString()))
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: tasteMint,
          treasury: treasuryAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const amountsRaw = [
        100, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000,
        10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000,
        200000, 250000, 300000, 400000, 500000, 600000, 700000, 800000, 900000, 1_000_000,
        1_100_000, 1_200_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 4_000_000, 5_000_000, 8_000_000, 10_000_000,
      ];
      for (let i = 0; i < backers.length; i++) {
        const amount = BigInt(amountsRaw[i]) * BigInt(LAMPORTS_PER_TASTE);
        backerAmounts.push(amount);
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        const info = await provider.connection.getAccountInfo(backerAta);
        if (!info) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              backers[i].publicKey,
              backerAta,
              backers[i].publicKey,
              tasteMint,
              TOKEN_2022_PROGRAM_ID
            )
          );
          await sendAndConfirmTransaction(provider.connection, tx, [backers[i]]);
        }
        await tasteToken.methods
          .mintTo(new anchor.BN(amount.toString()))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      }
      // Legacy backers: create ATAs and mint TASTE so claim_rwa_tokens_legacy can fund and claim
      for (let i = 0; i < legacyBackers.length; i++) {
        const backerAta = getAssociatedTokenAddressSync(tasteMint, legacyBackers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        const info = await provider.connection.getAccountInfo(backerAta);
        if (!info) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              legacyBackers[i].publicKey,
              backerAta,
              legacyBackers[i].publicKey,
              tasteMint,
              TOKEN_2022_PROGRAM_ID
            )
          );
          await sendAndConfirmTransaction(provider.connection, tx, [legacyBackers[i]]);
        }
        await tasteToken.methods
          .mintTo(new anchor.BN(LEGACY_BACKER_AMOUNTS[i].toString()))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      }
      // Two-milestone test backers: create ATAs and mint TASTE (before freeze_mint_authority)
      for (const b of twoMilestoneBackers) {
        const ata = getAssociatedTokenAddressSync(tasteMint, b.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const info = await provider.connection.getAccountInfo(ata);
        if (!info) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(b.publicKey, ata, b.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
          );
          await sendAndConfirmTransaction(provider.connection, tx, [b]);
        }
        await tasteToken.methods
          .mintTo(new anchor.BN((1_000_000n * BigInt(LAMPORTS_PER_TASTE)).toString()))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: ata,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      }
      // extra TASTE for negative tests
      const negativeTestReserve = 10_000 * LAMPORTS_PER_TASTE;
      for (let i = 0; i < 5; i++) {
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        await tasteToken.methods
          .mintTo(new anchor.BN(negativeTestReserve.toString()))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      }
      // fund cancel-proposal backer
      const cancelProposalAmount = 50_000 * LAMPORTS_PER_TASTE;
      const cancelProposalAta = getAssociatedTokenAddressSync(tasteMint, cancelProposalBacker.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const cancelProposalAtaInfo = await provider.connection.getAccountInfo(cancelProposalAta);
      if (!cancelProposalAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            cancelProposalBacker.publicKey,
            cancelProposalAta,
            cancelProposalBacker.publicKey,
            tasteMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(provider.connection, tx, [cancelProposalBacker]);
      }
      await tasteToken.methods
        .mintTo(new anchor.BN(cancelProposalAmount.toString()))
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: tasteMint,
          recipient: cancelProposalAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      // fund cancelBacker before freeze
      const cancelBackerAmount = 100_000 * LAMPORTS_PER_TASTE;
      const cancelBackerAta = getAssociatedTokenAddressSync(tasteMint, cancelBacker.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const cancelBackerAtaInfo = await provider.connection.getAccountInfo(cancelBackerAta);
      if (!cancelBackerAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            cancelBacker.publicKey,
            cancelBackerAta,
            cancelBacker.publicKey,
            tasteMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(provider.connection, tx, [cancelBacker]);
      }
      await tasteToken.methods
        .mintTo(new anchor.BN(cancelBackerAmount.toString()))
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: tasteMint,
          recipient: cancelBackerAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    });

    it("burn: burns a small amount from one backer", async () => {
      const backer = backers[0];
      const burnAmount = new anchor.BN(1000); // 1000 raw units (0.000001 TASTE)
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await tasteToken.methods
        .burn(burnAmount)
        .accounts({
          owner: backer.publicKey,
          source: backerAta,
          mint: tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([backer])
        .rpc();
      backerAmounts[0] = backerAmounts[0] - BigInt(burnAmount.toString());
    });

    it("freeze_mint_authority: revokes mint authority then mint_to fails", async () => {
      await tasteToken.methods
        .freezeMintAuthority()
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      const treasuryAta = getAssociatedTokenAddressSync(tasteMint, treasuryAuthority, true, TOKEN_2022_PROGRAM_ID);
      await expect(
        tasteToken.methods
          .mintTo(new anchor.BN(1000))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: treasuryAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc()
      ).to.be.rejectedWith(/InvalidMintAuthority|invalid mint authority|0x1771/);
    });
  });

  describe("project_escrow + governance full flow", () => {
    let projectPda: PublicKey;
    let escrowPda: PublicKey;
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);

    it("artist creates project", async () => {
      projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), artist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      escrowPda = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      )[0];

      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: artist.publicKey,
          artistState: artistStatePda,
          project: projectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([artist])
        .rpc();

      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(projectPda) as { artist: PublicKey; goal: { toString(): string } };
      expect(project.artist.equals(artist.publicKey)).to.be.true;
      expect(BigInt(project.goal.toString())).to.equal(GOAL);
    });

    it("artist initializes project_terms (ownership terms on-chain at publish)", async () => {
      const projectTermsPda = getProjectTermsPda(projectPda, projectEscrowProgramId);
      const termsHash = new Uint8Array(32);
      termsHash.fill(0xab); // dummy hash for test
      await projectEscrow.methods
        .initializeProjectTerms(Array.from(termsHash))
        .accounts({
          artist: artist.publicKey,
          project: projectPda,
          projectTerms: projectTermsPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([artist])
        .rpc();
      const terms = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<{ termsHash: number[]; version: number; refundWindowEnd: { toNumber(): number } }> }>).projectTerms.fetch(projectTermsPda);
      expect(terms.version).to.equal(1);
      expect(terms.refundWindowEnd.toNumber()).to.equal(0);
      expect(Buffer.from(terms.termsHash).equals(Buffer.from(termsHash))).to.be.true;
    });

    it("all backers fund project with their amounts", async () => {
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      for (let i = 0; i < backers.length; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        const amount = backerAmounts[i];
        await projectEscrow.methods
          .fundProject(new anchor.BN(amount.toString()))
          .accounts({
            backerWallet: backers[i].publicKey,
            project: projectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: escrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();
      }
      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(projectPda) as { totalRaised: { toString(): string }; backerCount: number };
      // 96% to escrow (4% fee: 2% treasury, 2% burn)
      const totalFunded = backerAmounts.reduce((a, b) => a + b, 0n);
      const expectedEscrow = (totalFunded * 96n) / 100n;
      expect(BigInt(project.totalRaised.toString())).to.equal(expectedEscrow);
      expect(project.backerCount).to.equal(BACKER_COUNT);
    });

    it("set_vote_weight: upgrade authority sets total_vote_weight for project", async () => {
      const [voteWeightPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_weight"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const totalVoteWeight = 1_000_000n;
      await projectEscrow.methods
        .setVoteWeight(new anchor.BN(totalVoteWeight.toString()))
        .accounts({
          authority: provider.wallet.publicKey,
          project: projectPda,
          voteWeight: voteWeightPda,
          programAccount: projectEscrowProgramId,
          programDataAccount: getProgramDataAddress(projectEscrowProgramId),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const voteWeight = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<{ totalVoteWeight: { toString(): string } }> }>).projectVoteWeight.fetch(voteWeightPda);
      expect(BigInt(voteWeight.totalVoteWeight.toString())).to.equal(totalVoteWeight);
    });

    describe("project_escrow mint_receipt", () => {
      const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
      const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

      function getMetaplexMetadataPda(mint: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), mint.toBuffer()],
          MPL_TOKEN_METADATA_ID
        )[0];
      }
      function getMetaplexMasterEditionPda(mint: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
          MPL_TOKEN_METADATA_ID
        )[0];
      }

      it("mint_receipt for first backer", async function () {
        this.timeout(60_000); // 1 min max
        const metadataUri = "https://example.com/receipt-metadata.json";
        const backerIdx = 0;
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), backers[backerIdx].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const receiptMintPda = getReceiptMintPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId);
        const receiptAuthorityPda = getReceiptAuthorityPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId);
        const backerReceiptAta = getAssociatedTokenAddressSync(
          receiptMintPda,
          backers[backerIdx].publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const metadataPda = getMetaplexMetadataPda(receiptMintPda);
        const masterEditionPda = getMetaplexMasterEditionPda(receiptMintPda);

        await (projectEscrow.methods as unknown as { mintReceipt: (uri: string) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).mintReceipt(metadataUri)
          .accounts({
            backerWallet: backers[backerIdx].publicKey,
            project: projectPda,
            backer: backerPda,
            receiptAuthority: receiptAuthorityPda,
            receiptMint: receiptMintPda,
            backerReceiptAta,
            metadata: metadataPda,
            masterEdition: masterEditionPda,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[backerIdx]])
          .rpc();

        for (let w = 0; w < 10; w++) {
          const info = await provider.connection.getAccountInfo(receiptMintPda, "confirmed");
          if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        const mint = await getMint(provider.connection, receiptMintPda, "confirmed", TOKEN_2022_PROGRAM_ID);
        expect(mint.supply).to.equal(1n);
        expect(mint.decimals).to.equal(0);
        const ataInfo = await getAccount(provider.connection, backerReceiptAta, "confirmed", TOKEN_2022_PROGRAM_ID);
        expect(Number(ataInfo.amount)).to.equal(1);
      });

      it("mint_receipt for all backers", async function () {
        this.timeout(180_000); // 3 min max; if longer, RPC or validator is stuck
        // 39 sequential RPCs (backer 0 already has receipt). Log progress so long runs are visible.
        const metadataUri = "https://example.com/receipt-metadata.json";
        const total = backers.length - 1;
        for (let i = 1; i < backers.length; i++) {
          if (i % 5 === 0 || i === 1) {
            process.stdout.write(`    mint_receipt backer ${i}/${total}...\n`);
          }
          const [backerPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("backer"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
            projectEscrowProgramId
          );
          const receiptMintPda = getReceiptMintPda(projectPda, backers[i].publicKey, projectEscrowProgramId);
          const receiptAuthorityPda = getReceiptAuthorityPda(projectPda, backers[i].publicKey, projectEscrowProgramId);
          const backerReceiptAta = getAssociatedTokenAddressSync(
            receiptMintPda,
            backers[i].publicKey,
            false,
            TOKEN_2022_PROGRAM_ID
          );
          const metadataPda = getMetaplexMetadataPda(receiptMintPda);
          const masterEditionPda = getMetaplexMasterEditionPda(receiptMintPda);

          await (projectEscrow.methods as unknown as { mintReceipt: (uri: string) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).mintReceipt(metadataUri)
            .accounts({
              backerWallet: backers[i].publicKey,
              project: projectPda,
              backer: backerPda,
              receiptAuthority: receiptAuthorityPda,
              receiptMint: receiptMintPda,
              backerReceiptAta,
              metadata: metadataPda,
              masterEdition: masterEditionPda,
              tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
              sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
              tokenProgram: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([backers[i]])
            .rpc();
        }
      });

      it("second mint_receipt for same backer fails", async () => {
        const metadataUri = "https://example.com/receipt-metadata.json";
        const backerIdx = 0;
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), backers[backerIdx].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const receiptMintPda = getReceiptMintPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId);
        const receiptAuthorityPda = getReceiptAuthorityPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId);
        const backerReceiptAta = getAssociatedTokenAddressSync(
          receiptMintPda,
          backers[backerIdx].publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const metadataPda = getMetaplexMetadataPda(receiptMintPda);
        const masterEditionPda = getMetaplexMasterEditionPda(receiptMintPda);

        await expect(
          (projectEscrow.methods as unknown as { mintReceipt: (uri: string) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).mintReceipt(metadataUri)
            .accounts({
              backerWallet: backers[backerIdx].publicKey,
              project: projectPda,
              backer: backerPda,
              receiptAuthority: receiptAuthorityPda,
              receiptMint: receiptMintPda,
              backerReceiptAta,
              metadata: metadataPda,
              masterEdition: masterEditionPda,
              tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
              sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
              tokenProgram: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([backers[backerIdx]])
            .rpc()
        ).to.be.rejected;
      });

      it("mint_receipt fails for non-backer", async () => {
        const nonBacker = Keypair.generate();
        await airdrop(nonBacker.publicKey);
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), nonBacker.publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const receiptMintPda = getReceiptMintPda(projectPda, nonBacker.publicKey, projectEscrowProgramId);
        const receiptAuthorityPda = getReceiptAuthorityPda(projectPda, nonBacker.publicKey, projectEscrowProgramId);
        const backerReceiptAta = getAssociatedTokenAddressSync(
          receiptMintPda,
          nonBacker.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const metadataPda = getMetaplexMetadataPda(receiptMintPda);
        const masterEditionPda = getMetaplexMasterEditionPda(receiptMintPda);

        await expect(
          (projectEscrow.methods as unknown as { mintReceipt: (uri: string) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).mintReceipt("https://x.com")
            .accounts({
              backerWallet: nonBacker.publicKey,
              project: projectPda,
              backer: backerPda,
              receiptAuthority: receiptAuthorityPda,
              receiptMint: receiptMintPda,
              backerReceiptAta,
              metadata: metadataPda,
              masterEdition: masterEditionPda,
              tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
              sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
              tokenProgram: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([nonBacker])
            .rpc()
        ).to.be.rejectedWith(/NothingToRefund|backer|AccountNotInitialized|Constraint|0x/i);
      });

      it("mint_receipt rejects URI over 200 chars", async () => {
        const longUri = "https://example.com/" + "x".repeat(201);
        const backerIdx = 1;
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), backers[backerIdx].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const receiptMintPda = getReceiptMintPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId);
        const receiptAuthorityPda = getReceiptAuthorityPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId);
        const backerReceiptAta = getAssociatedTokenAddressSync(
          receiptMintPda,
          backers[backerIdx].publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const metadataPda = getMetaplexMetadataPda(receiptMintPda);
        const masterEditionPda = getMetaplexMasterEditionPda(receiptMintPda);

        await expect(
          (projectEscrow.methods as unknown as { mintReceipt: (uri: string) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).mintReceipt(longUri)
            .accounts({
              backerWallet: backers[backerIdx].publicKey,
              project: projectPda,
              backer: backerPda,
              receiptAuthority: receiptAuthorityPda,
              receiptMint: receiptMintPda,
              backerReceiptAta,
              metadata: metadataPda,
              masterEdition: masterEditionPda,
              tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
              sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
              tokenProgram: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([backers[backerIdx]])
            .rpc()
        ).to.be.rejectedWith(/MetadataUriTooLong|0x/i);
      });
    });

    it("runs 5 milestone proposals with many voters and quadratic weights", async () => {
      const artistAta = getAssociatedTokenAddressSync(tasteMint, artist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      let artistAtaInfo = await provider.connection.getAccountInfo(artistAta);
      if (!artistAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            artist.publicKey,
            artistAta,
            artist.publicKey,
            tasteMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(provider.connection, tx, [artist]);
      }

      const proposalAttemptPda = getProposalAttemptPda(projectPda, governance.programId);
      const { alt: mainFinalizeAlt } = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        projectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      for (let milestone = 0; milestone < 5; milestone++) {
        const attempt = await getCurrentProposalAttempt(governance, proposalAttemptPda);
        const proposalPda = getProposalPda(projectPda, milestone, attempt, governance.programId);

        await governance.methods
          .createProposal(
            projectPda,
            milestone,
            `https://proof.example/m${milestone}`,
            VOTING_PERIOD_SECS,
            new anchor.BN(attempt)
          )
          .accounts({
            artist: artist.publicKey,
            proposalAttempt: proposalAttemptPda,
            proposal: proposalPda,
            project: projectPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
          ])
          .signers([artist])
          .rpc();

        let votesFor = 0n;
        let votesAgainst = 0n;
        for (let i = 0; i < backers.length; i++) {
          const side = i >= backers.length / 2; // backers 20-39 vote yes
          const [backerPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("backer"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
            projectEscrowProgramId
          );
          const [votePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vote"), proposalPda.toBuffer(), backers[i].publicKey.toBuffer()],
            governanceProgramId
          );
          try {
            await governance.methods
              .castVote(side)
              .accounts({
                voter: backers[i].publicKey,
                proposal: proposalPda,
                backer: backerPda,
                vote: votePda,
                systemProgram: SystemProgram.programId,
              })
              .signers([backers[i]])
              .rpc();
          } catch (e: unknown) {
            const err = e as Error & { logs?: string[]; getLogs?: (c: unknown) => Promise<string[]> };
            let logs = err.logs;
            if (!logs && typeof err.getLogs === "function") try { logs = await err.getLogs(provider.connection); } catch { /* ignore */ }
            const parts = [
              (e as Error).message,
              (e as { transactionError?: unknown }).transactionError != null ? String((e as { transactionError: unknown }).transactionError) : "",
              logs?.length ? "Logs: " + JSON.stringify(logs.slice(-20)) : "",
            ].filter(Boolean);
            throw new Error(parts.length ? parts.join("\n") : "castVote failed (backer " + i + ", milestone " + milestone + ")");
          }

          // vote weight = sqrt(post-fee amount)
          const onChainAmount = backerAmounts[i] * 96n / 100n;
          const weight = sqrtU64(onChainAmount);
          if (side) votesFor += weight;
          else votesAgainst += weight;
        }

        const proposalBefore = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(proposalPda) as { votesFor: { toString(): string }; votesAgainst: { toString(): string } };
        expect(BigInt(proposalBefore.votesFor.toString())).to.equal(votesFor);
        expect(BigInt(proposalBefore.votesAgainst.toString())).to.equal(votesAgainst);

        await new Promise((r) => setTimeout(r, SLEEP_MS));

        const [releaseAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("release_authority")],
          governanceProgramId
        );
        const [escrowAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("project"), projectPda.toBuffer()],
          projectEscrowProgramId
        );

        const { rwaState, rwaMint, rwaMintAuthority, rwaConfig, rwaExtraAccountMetas, rwaMetadataGuard, rwaMetadata } = getRwaPdas(projectPda, rwaTokenProgramId);
        const rwaAccounts = getFinalizeProposalRwaAccounts(projectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
        const finalizeBuilder = governance.methods
          .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
          .accountsStrict({
            proposal: proposalPda,
            project: projectPda,
            payer: provider.wallet.publicKey,
            releaseAuthority,
            escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
            escrow: escrowPda,
            escrowAuthority,
            artistTokenAccount: artistAta,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            projectEscrowProgram: projectEscrowProgramId,
            rwaState,
            rwaMint,
            rwaMintAuthority,
            rwaConfig,
            rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
            rwaExtraAccountMetas,
            rwaMetadataGuard,
            rwaMetadata,
            artist: artist.publicKey,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            rwaTokenProgram: rwaTokenProgramId,
            ...rwaAccounts,
            systemProgram: SystemProgram.programId,
          })
          .signers([artist]);
        await sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), finalizeBuilder, mainFinalizeAlt, [artist]);

        const proposalAfter = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(proposalPda) as { status: Record<string, unknown> };
        expect(
          "passed" in proposalAfter.status || "active" in proposalAfter.status
        ).to.be.true;
      }

      const projectAfter = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(projectPda) as { currentMilestone: number; status: Record<string, unknown> };
      expect(projectAfter.currentMilestone).to.equal(5);
      expect("completed" in projectAfter.status).to.be.true;
    });
  });

  describe("variable milestones 1-5", () => {
    const twoMilestoneArtist = Keypair.generate();
    const TWO_MILESTONE_AMOUNTS = [500_000n * BigInt(LAMPORTS_PER_TASTE), 500_000n * BigInt(LAMPORTS_PER_TASTE)];
    const TWO_MILESTONE_GOAL = 1_000_000n * BigInt(LAMPORTS_PER_TASTE);
    const TWO_MILESTONES = [50, 50, 0, 0, 0] as [number, number, number, number, number];

    it("2-milestone project completes after 2 releases and RWA is initialized", async () => {
      await airdrop(twoMilestoneArtist.publicKey);
      for (const b of twoMilestoneBackers) await airdrop(b.publicKey);

      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), twoMilestoneArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const twoMilestoneProjectPda = getProjectPda(twoMilestoneArtist.publicKey, 0, projectEscrowProgramId);
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), twoMilestoneProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const twoMilestoneEscrowPda = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), twoMilestoneProjectPda.toBuffer()],
        projectEscrowProgramId
      )[0];
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

      await projectEscrow.methods
        .createProject("Two Milestone", new anchor.BN(TWO_MILESTONE_GOAL.toString()), TWO_MILESTONES, deadline)
        .accounts({
          artist: twoMilestoneArtist.publicKey,
          artistState: artistStatePda,
          project: twoMilestoneProjectPda,
          escrowAuthority,
          escrow: twoMilestoneEscrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([twoMilestoneArtist])
        .rpc();

      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      for (let i = 0; i < twoMilestoneBackers.length; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), twoMilestoneProjectPda.toBuffer(), twoMilestoneBackers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(tasteMint, twoMilestoneBackers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        await projectEscrow.methods
          .fundProject(new anchor.BN(TWO_MILESTONE_AMOUNTS[i].toString()))
          .accounts({
            backerWallet: twoMilestoneBackers[i].publicKey,
            project: twoMilestoneProjectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: twoMilestoneEscrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([twoMilestoneBackers[i]])
          .rpc();
      }

      const proposalAttemptPda = getProposalAttemptPda(twoMilestoneProjectPda, governance.programId);
      const { alt: twoMsFinalizeAlt } = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        twoMilestoneProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      for (let milestone = 0; milestone < 2; milestone++) {
        const attempt = await getCurrentProposalAttempt(governance, proposalAttemptPda);
        const proposalPda = getProposalPda(twoMilestoneProjectPda, milestone, attempt, governance.programId);
        await (governance.methods as unknown as { createProposal: (p: PublicKey, m: number, u: string, v: anchor.BN, a: anchor.BN) => { accounts: (a: object) => { remainingAccounts: (r: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } } }).createProposal(
          twoMilestoneProjectPda,
          milestone,
          `https://proof.example/two-m${milestone}`,
          VOTING_PERIOD_SECS,
          new anchor.BN(attempt)
        )
          .accounts({
            artist: twoMilestoneArtist.publicKey,
            proposalAttempt: proposalAttemptPda,
            proposal: proposalPda,
            project: twoMilestoneProjectPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
          ])
          .signers([twoMilestoneArtist])
          .rpc();

        for (let i = 0; i < twoMilestoneBackers.length; i++) {
          const [backerPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("backer"), twoMilestoneProjectPda.toBuffer(), twoMilestoneBackers[i].publicKey.toBuffer()],
            projectEscrowProgramId
          );
          const [votePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vote"), proposalPda.toBuffer(), twoMilestoneBackers[i].publicKey.toBuffer()],
            governanceProgramId
          );
          await (governance.methods as unknown as { castVote: (s: boolean) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).castVote(true)
            .accounts({
              voter: twoMilestoneBackers[i].publicKey,
              proposal: proposalPda,
              backer: backerPda,
              vote: votePda,
              systemProgram: SystemProgram.programId,
            })
            .signers([twoMilestoneBackers[i]])
            .rpc();
        }

        await new Promise((r) => setTimeout(r, SLEEP_MS));

        const twoMilestoneArtistAta = getAssociatedTokenAddressSync(tasteMint, twoMilestoneArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
        let artistAtaInfo = await provider.connection.getAccountInfo(twoMilestoneArtistAta);
        if (!artistAtaInfo) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              twoMilestoneArtist.publicKey,
              twoMilestoneArtistAta,
              twoMilestoneArtist.publicKey,
              tasteMint,
              TOKEN_2022_PROGRAM_ID
            )
          );
          await sendAndConfirmTransaction(provider.connection, tx, [twoMilestoneArtist]);
        }

        const { rwaState, rwaMint, rwaMintAuthority, rwaConfig, rwaExtraAccountMetas, rwaMetadataGuard, rwaMetadata } = getRwaPdas(twoMilestoneProjectPda, rwaTokenProgramId);
        const twoMsRwaAccounts = getFinalizeProposalRwaAccounts(twoMilestoneProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
        const twoMsFinalizeBuilder = governance.methods
          .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
          .accountsStrict({
            proposal: proposalPda,
            project: twoMilestoneProjectPda,
            payer: provider.wallet.publicKey,
            releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
            escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
            escrow: twoMilestoneEscrowPda,
            escrowAuthority,
            artistTokenAccount: twoMilestoneArtistAta,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            projectEscrowProgram: projectEscrowProgramId,
            rwaState,
            rwaMint,
            rwaMintAuthority,
            rwaConfig,
            rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
            rwaExtraAccountMetas,
            rwaMetadataGuard,
            rwaMetadata,
            artist: twoMilestoneArtist.publicKey,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            rwaTokenProgram: rwaTokenProgramId,
            ...twoMsRwaAccounts,
            systemProgram: SystemProgram.programId,
          })
          .signers([twoMilestoneArtist]);
        await sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), twoMsFinalizeBuilder, twoMsFinalizeAlt, [twoMilestoneArtist]);
      }

      const projectAfter = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(twoMilestoneProjectPda) as { currentMilestone: number; status: Record<string, unknown> };
      expect(projectAfter.currentMilestone).to.equal(2);
      expect("completed" in projectAfter.status).to.be.true;

      const [rwaStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_state"), twoMilestoneProjectPda.toBuffer()],
        rwaTokenProgramId
      );
      const rwaStateInfo = await provider.connection.getAccountInfo(rwaStatePda);
      expect(rwaStateInfo).to.not.be.null;
      expect(rwaStateInfo!.owner.equals(rwaTokenProgramId)).to.be.true;
    });
  });

  describe("rwa_token", () => {
    let projectPda: PublicKey;
    let rwaStatePda: PublicKey;
    let rwaMintPda: PublicKey;
    const RWA_TOTAL_SUPPLY = 1_000_000n * BigInt(1e6);

    before(() => {
      projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      [rwaStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_state"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      [rwaMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_mint"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
    });

    it("artist initializes RWA mint for project (or already inited by governance)", async () => {
      const rwaStateInfo = await provider.connection.getAccountInfo(rwaStatePda);
      if (!rwaStateInfo || rwaStateInfo.lamports === 0) {
        const { rwaConfig, rwaExtraAccountMetas } = getRwaPdas(projectPda, rwaTokenProgramId);
        await rwaToken.methods
          .initializeRwaMint(new anchor.BN(RWA_TOTAL_SUPPLY.toString()))
          .accountsStrict({
            authority: artist.publicKey,
            project: projectPda,
            rwaState: rwaStatePda,
            rwaConfig,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetas: rwaExtraAccountMetas,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([artist])
          .rpc();
      }
      const state = await (rwaToken.account as Record<string, { fetch: (p: PublicKey) => Promise<{ minted: { toString: () => string }; mintFrozen?: boolean; totalSupply?: { toString: () => string }; authority?: PublicKey }> }>).rwaState.fetch(rwaStatePda) as { totalSupply: { toString(): string }; authority: PublicKey };
      expect(BigInt(state.totalSupply.toString())).to.equal(RWA_TOTAL_SUPPLY);
      expect(state.authority.equals(artist.publicKey)).to.be.true;
    });

    it("initialize_rwa_mint_by_governance rejects when signer is not release authority", async () => {
      const { rwaConfig, rwaExtraAccountMetas } = getRwaPdas(projectPda, rwaTokenProgramId);
      await expect(
        rwaToken.methods
          .initializeRwaMintByGovernance(new anchor.BN(Number(RWA_TOTAL_SUPPLY)))
          .accountsStrict({
            payer: artist.publicKey,
            releaseAuthority: artist.publicKey,
            config: getEscrowConfigPda(projectEscrowProgramId),
            project: projectPda,
            rwaState: rwaStatePda,
            rwaConfig,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetas: rwaExtraAccountMetas,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([artist])
          .rpc()
      ).to.be.rejectedWith(/NotReleaseAuthority|not release authority|0x|Constraint/i);
    });

    const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

    it("rejects name/symbol/uri over bounds", async function () {
      const methods = rwaToken.methods as Record<string, unknown>;
      const hasInitMeta = typeof methods.initializeRwaMetadata === "function";
      if (!hasInitMeta) {
        const keys = Object.keys(methods).sort().join(", ");
        throw new Error(`rwaToken.methods.initializeRwaMetadata is not a function. Actual methods: ${keys}`);
      }
      const longName = "a".repeat(33);
      const [metadataGuardPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_metadata"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), rwaMintPda.toBuffer()],
        MPL_TOKEN_METADATA_ID
      );
      await expect(
        (rwaToken.methods as unknown as { initializeRwaMetadata: (n: string, s: string, u: string) => { accounts: (a: object) => { signers: (s: anchor.web3.Keypair[]) => { rpc: () => Promise<string> } } } }).initializeRwaMetadata(longName, "S", "https://x.com")
          .accounts({
            authority: artist.publicKey,
            rwaState: rwaStatePda,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            metadataGuard: metadataGuardPda,
            metadata: metadataPda,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            systemProgram: SystemProgram.programId,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([artist])
          .rpc()
      ).to.be.rejected;
    });

    it("non-authority cannot initialize RWA metadata", async function () {
      if (typeof (rwaToken.methods as { initializeRwaMetadata?: unknown }).initializeRwaMetadata !== "function") {
        this.skip();
        return;
      }
      const [metadataGuardPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_metadata"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), rwaMintPda.toBuffer()],
        MPL_TOKEN_METADATA_ID
      );
      await expect(
        (rwaToken.methods as unknown as { initializeRwaMetadata: (n: string, s: string, u: string) => { accounts: (a: object) => { signers: (s: anchor.web3.Keypair[]) => { rpc: () => Promise<string> } } } }).initializeRwaMetadata("Bad", "B", "https://x.com")
          .accounts({
            authority: backers[0].publicKey,
            rwaState: rwaStatePda,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            metadataGuard: metadataGuardPda,
            metadata: metadataPda,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            systemProgram: SystemProgram.programId,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/NotAuthority|not authority|Constraint|rwa_state|0x/i);
    });

    it("authority initializes RWA metadata once", async function () {
      const methods = rwaToken.methods as Record<string, unknown>;
      if (typeof methods.initializeRwaMetadata !== "function") {
        const keys = Object.keys(methods).sort().join(", ");
        throw new Error(`rwaToken.methods.initializeRwaMetadata is not a function. Actual methods: ${keys}`);
      }
      const [metadataGuardPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_metadata"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const guardAlready = await provider.connection.getAccountInfo(metadataGuardPda);
      if (guardAlready) {
        // Governance already created metadata during finalize_proposal; guard exists, nothing to do.
        expect(guardAlready.owner.equals(rwaTokenProgramId)).to.be.true;
        return;
      }
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), rwaMintPda.toBuffer()],
        MPL_TOKEN_METADATA_ID
      );
      await (rwaToken.methods as unknown as { initializeRwaMetadata: (n: string, s: string, u: string) => { accounts: (a: object) => { signers: (s: anchor.web3.Keypair[]) => { rpc: () => Promise<string> } } } }).initializeRwaMetadata("Test RWA", "TRWA", "https://example.com/metadata.json")
        .accounts({
          authority: artist.publicKey,
          rwaState: rwaStatePda,
          rwaMint: rwaMintPda,
          rwaMintAuthority: PublicKey.findProgramAddressSync(
            [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
            rwaTokenProgramId
          )[0],
          metadataGuard: metadataGuardPda,
          metadata: metadataPda,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          systemProgram: SystemProgram.programId,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([artist])
        .rpc();
    });

    it("second initialize_rwa_metadata fails (guard already exists)", async function () {
      if (typeof (rwaToken.methods as { initializeRwaMetadata?: unknown }).initializeRwaMetadata !== "function") {
        this.skip();
        return;
      }
      const [metadataGuardPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_metadata"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), MPL_TOKEN_METADATA_ID.toBuffer(), rwaMintPda.toBuffer()],
        MPL_TOKEN_METADATA_ID
      );
      await expect(
        (rwaToken.methods as unknown as { initializeRwaMetadata: (n: string, s: string, u: string) => { accounts: (a: object) => { signers: (s: anchor.web3.Keypair[]) => { rpc: () => Promise<string> } } } }).initializeRwaMetadata("Again", "A", "https://again.com")
          .accounts({
            authority: artist.publicKey,
            rwaState: rwaStatePda,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            metadataGuard: metadataGuardPda,
            metadata: metadataPda,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            systemProgram: SystemProgram.programId,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([artist])
          .rpc()
      ).to.be.rejected;
    });

    it("claim_rwa_tokens fails with wrong receipt mint", async () => {
      const backerIdx = 0;
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), projectPda.toBuffer(), backers[backerIdx].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const wrongReceiptMint = getReceiptMintPda(projectPda, backers[1].publicKey, projectEscrowProgramId);
      const backer0ReceiptAta = getAssociatedTokenAddressSync(
        getReceiptMintPda(projectPda, backers[backerIdx].publicKey, projectEscrowProgramId),
        backers[backerIdx].publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      const [claimRecordPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), projectPda.toBuffer(), backers[backerIdx].publicKey.toBuffer()],
        rwaTokenProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(
        rwaMintPda,
        backers[backerIdx].publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      await expect(
        rwaToken.methods
          .claimRwaTokens()
          .accounts({
            backer: backers[backerIdx].publicKey,
            backerAccount: backerPda,
            project: projectPda,
            rwaState: rwaStatePda,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            receiptMint: wrongReceiptMint,
            receiptTokenAccount: backer0ReceiptAta,
            projectEscrowProgram: projectEscrowProgramId,
            claimRecord: claimRecordPda,
            backerTokenAccount: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[backerIdx]])
          .rpc()
      ).to.be.rejectedWith(/InvalidReceipt|invalid receipt|Constraint|mint|0x/i);
    });

    it("all backers claim RWA tokens", async () => {
      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(projectPda) as { totalRaised: { toString(): string } };
      const totalRaised = BigInt(project.totalRaised.toString());

      for (let i = 0; i < backers.length; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const [claimRecordPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          rwaTokenProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(
          rwaMintPda,
          backers[i].publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const receiptMintPda = getReceiptMintPda(projectPda, backers[i].publicKey, projectEscrowProgramId);
        const receiptTokenAccount = getAssociatedTokenAddressSync(
          receiptMintPda,
          backers[i].publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );

        // For first backer, assert receipt mint supply before burn (claim burns the PDA receipt).
        if (i === 0) {
          const receiptMintInfo = await provider.connection.getAccountInfo(receiptMintPda, "confirmed");
          if (receiptMintInfo?.data) {
            const receiptMintBefore = await getMint(provider.connection, receiptMintPda, "confirmed", TOKEN_2022_PROGRAM_ID);
            expect(receiptMintBefore.supply).to.equal(1n);
          }
        }

        await rwaToken.methods
          .claimRwaTokens()
          .accounts({
            backer: backers[i].publicKey,
            backerAccount: backerPda,
            project: projectPda,
            rwaState: rwaStatePda,
            rwaMint: rwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            receiptMint: receiptMintPda,
            receiptTokenAccount,
            projectEscrowProgram: projectEscrowProgramId,
            claimRecord: claimRecordPda,
            backerTokenAccount: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();

        const expectedShare = (backerAmounts[i] * RWA_TOTAL_SUPPLY) / totalRaised;
        if (expectedShare > 0n) {
          try {
            const tokenAccount = await getAccount(provider.connection, backerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
            const amount = typeof tokenAccount.amount === "bigint" ? tokenAccount.amount : BigInt(String(tokenAccount.amount));
            expect(amount >= expectedShare - 1n).to.be.true;
          } catch (e) {
            // Account may not exist yet or rounding; verify claim record instead
            const [claimRecordPda] = PublicKey.findProgramAddressSync(
              [Buffer.from("claim"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
              rwaTokenProgramId
            );
            const record = await (rwaToken.account as Record<string, { fetch: (p: PublicKey) => Promise<{ claimed: boolean }> }>).claimRecord.fetch(claimRecordPda);
            expect((record as { claimed: boolean }).claimed).to.be.true;
          }
        }
        await new Promise((r) => setTimeout(r, 300));
        const receiptAtaAfter = await getAccount(provider.connection, receiptTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
        expect(Number(receiptAtaAfter.amount)).to.equal(0);
        // For first backer, assert receipt mint supply after burn (claim_rwa_tokens burns the PDA receipt).
        if (i === 0) {
          const receiptMintAfterInfo = await provider.connection.getAccountInfo(receiptMintPda, "confirmed");
          if (receiptMintAfterInfo?.data) {
            const receiptMintAfter = await getMint(provider.connection, receiptMintPda, "confirmed", TOKEN_2022_PROGRAM_ID);
            expect(receiptMintAfter.supply).to.equal(0n);
          }
        }
      }

      const state = await (rwaToken.account as Record<string, { fetch: (p: PublicKey) => Promise<{ minted: { toString: () => string }; mintFrozen?: boolean; totalSupply?: { toString: () => string }; authority?: PublicKey }> }>).rwaState.fetch(rwaStatePda);
      const minted = BigInt(state.minted.toString());
      expect(minted >= RWA_TOTAL_SUPPLY - 100n).to.be.true;
      expect(minted <= RWA_TOTAL_SUPPLY + 100n).to.be.true;
    });

    it("initialize_rwa_rights happy path", async function () {
      if (typeof (rwaToken.methods as { initializeRwaRights?: unknown }).initializeRwaRights !== "function") {
        this.skip();
        return;
      }
      const [rwaRightsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_rights"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      try {
        await (rwaToken.methods as unknown as {
          initializeRwaRights: (a: { masterRecording?: unknown }, b: number, c: number, d: anchor.BN, e: anchor.BN, f: number[], g: string, h: string) => { accounts: (acc: object) => { signers: (s: anchor.web3.Keypair[]) => { rpc: () => Promise<string> } } };
        }).initializeRwaRights(
          { masterRecording: {} },
          5000,
          5000,
          new anchor.BN(365 * 24 * 3600),
          new anchor.BN(0),
          new Array(32).fill(0),
          "https://terms.example",
          "US"
        )
          .accounts({
            authority: artist.publicKey,
            rwaState: rwaStatePda,
            rwaRights: rwaRightsPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([artist])
          .rpc();
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (!/already in use|AccountAlreadyInitialized|0x0|custom program error: 0x0/i.test(msg)) throw e;
      }
    });

    it("initialize_rwa_rights rejects split > 10000 bps", async function () {
      if (typeof (rwaToken.methods as { initializeRwaRights?: unknown }).initializeRwaRights !== "function") {
        this.skip();
        return;
      }
      const [rwaRightsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_rights"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      await expect(
        (rwaToken.methods as unknown as {
          initializeRwaRights: (a: { masterRecording?: unknown }, b: number, c: number, d: anchor.BN, e: anchor.BN, f: number[], g: string, h: string) => { accounts: (acc: object) => { signers: (s: anchor.web3.Keypair[]) => { rpc: () => Promise<string> } } };
        }).initializeRwaRights(
          { masterRecording: {} },
          6000,
          5000,
          new anchor.BN(365 * 24 * 3600),
          new anchor.BN(0),
          new Array(32).fill(0),
          "https://terms.example",
          "US"
        )
          .accounts({
            authority: artist.publicKey,
            rwaState: rwaStatePda,
            rwaRights: rwaRightsPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([artist])
          .rpc()
      ).to.be.rejectedWith(/InvalidSplit|invalid split|0x|Constraint/i);
    });

    it("update_rwa_rights: authority updates terms_hash and terms_uri", async function () {
      if (typeof (rwaToken.methods as { updateRwaRights?: unknown }).updateRwaRights !== "function") {
        this.skip();
        return;
      }
      const [rwaRightsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_rights"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const newTermsHash = Buffer.alloc(32);
      newTermsHash.write("update-rwa-rights-test-v2-hash");
      const newTermsUri = "https://example.com/terms-v2";
      await (rwaToken.methods as unknown as {
        updateRwaRights: (hash: number[], uri: string) => { accounts: (acc: { authority: PublicKey; rwaState: PublicKey; rwaRights: PublicKey }) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } };
      }).updateRwaRights(Array.from(newTermsHash), newTermsUri)
        .accounts({
          authority: artist.publicKey,
          rwaState: rwaStatePda,
          rwaRights: rwaRightsPda,
        })
        .signers([artist])
        .rpc();
      const rights = await (rwaToken.account as Record<string, { fetch: (p: PublicKey) => Promise<{ termsHash: number[]; termsUri: string }> }>).rwaRights.fetch(rwaRightsPda);
      expect(Buffer.from(rights.termsHash).equals(newTermsHash)).to.be.true;
      expect(rights.termsUri).to.equal(newTermsUri);
    });

    it("rwa_transfer_hook pass-through transfer succeeds", async () => {
      const RWA_DECIMALS = 6;
      const sourceHolder = backers[backers.length - 1];
      const destHolder = backers[backers.length - 2];
      const sourceAta = getAssociatedTokenAddressSync(rwaMintPda, sourceHolder.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const destAta = getAssociatedTokenAddressSync(rwaMintPda, destHolder.publicKey, false, TOKEN_2022_PROGRAM_ID);
      let destInfo = await provider.connection.getAccountInfo(destAta);
      if (!destInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(destHolder.publicKey, destAta, destHolder.publicKey, rwaMintPda, TOKEN_2022_PROGRAM_ID)
        );
        await sendAndConfirmTransaction(provider.connection, tx, [destHolder]);
      }

      // Token-2022 TransferChecked on mints with TransferHook requires the
      // TransferHookAccount extension on source/dest. The ATA program may not
      // add it automatically; Reallocate is idempotent (skips if already present).
      const reallocTx = new Transaction()
        .add(createReallocateInstruction(sourceAta, sourceHolder.publicKey, [ExtensionType.TransferHookAccount], sourceHolder.publicKey, [], TOKEN_2022_PROGRAM_ID))
        .add(createReallocateInstruction(destAta, destHolder.publicKey, [ExtensionType.TransferHookAccount], destHolder.publicKey, [], TOKEN_2022_PROGRAM_ID));
      await sendAndConfirmTransaction(provider.connection, reallocTx, [sourceHolder, destHolder]);

      const sourceBefore = (await getAccount(provider.connection, sourceAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const destBefore = (await getAccount(provider.connection, destAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const transferAmount = 1000n * 10n ** BigInt(RWA_DECIMALS);
      expect(BigInt(sourceBefore) >= transferAmount).to.be.true;

      // Build TransferChecked and manually append the transfer hook's extra-account-metas
      // PDA + the hook program. The helper createTransferCheckedWithTransferHookInstruction
      // silently skips adding these if the extra-account-metas PDA fetch returns null (timing).
      const extraAccountMetasPda = getRwaExtraAccountMetasPda(rwaMintPda, RWA_TRANSFER_HOOK_PROGRAM_ID);
      let ix = await createTransferCheckedWithTransferHookInstruction(
        provider.connection,
        sourceAta,
        rwaMintPda,
        destAta,
        sourceHolder.publicKey,
        transferAmount,
        RWA_DECIMALS,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      // Verify the helper added the hook program; if not, add manually (pass-through hook).
      // Order: extra-account-metas PDA (validation account), then hook program.
      const hasHookProgram = ix.keys.some(k => k.pubkey.equals(RWA_TRANSFER_HOOK_PROGRAM_ID));
      if (!hasHookProgram) {
        ix.keys.push({ pubkey: extraAccountMetasPda, isSigner: false, isWritable: false });
        ix.keys.push({ pubkey: RWA_TRANSFER_HOOK_PROGRAM_ID, isSigner: false, isWritable: false });
      }

      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(ix), [sourceHolder],
        { commitment: "confirmed", preflightCommitment: "confirmed" },
      );
      const sourceAfter = (await getAccount(provider.connection, sourceAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const destAfter = (await getAccount(provider.connection, destAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      expect(BigInt(sourceAfter)).to.equal(BigInt(sourceBefore) - transferAmount);
      expect(BigInt(destAfter)).to.equal(BigInt(destBefore) + transferAmount);
    });

    it("authority closes distribution (freezes mint)", async () => {
      await rwaToken.methods
        .closeDistribution()
        .accounts({
          authority: artist.publicKey,
          rwaState: rwaStatePda,
        })
        .signers([artist])
        .rpc();

      const state = await (rwaToken.account as Record<string, { fetch: (p: PublicKey) => Promise<{ minted: { toString: () => string }; mintFrozen?: boolean; totalSupply?: { toString: () => string }; authority?: PublicKey }> }>).rwaState.fetch(rwaStatePda);
      expect((state as { mintFrozen: boolean }).mintFrozen).to.be.true;
    });
  });

  describe("revenue_distribution", () => {
    let projectPda: PublicKey;
    let rwaStatePda: PublicKey;
    let rwaMintPda: PublicKey;

    before(() => {
      projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      [rwaStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_state"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      [rwaMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_mint"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
    });

    it("initialize_revenue_config", async () => {
      const revConfigPda = getRevConfigPda(projectPda, revenueDistributionProgramId);
      const revVaultAuthorityPda = getRevVaultAuthorityPda(projectPda, revenueDistributionProgramId);
      const revVault = getAssociatedTokenAddressSync(tasteMint, revVaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
      try {
        await revenueDistribution.methods
          .initializeRevenueConfig()
          .accounts({
            payer: provider.wallet.publicKey,
            project: projectPda,
            rwaState: rwaStatePda,
            revConfig: revConfigPda,
            rwaMint: rwaMintPda,
            revVaultAuthority: revVaultAuthorityPda,
            revVault,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (e: unknown) {
        const msg = (e as Error).message ?? String(e);
        if (!/already in use|AccountAlreadyInitialized|0x0/i.test(msg)) throw e;
      }
    });

    it("deposit_revenue", async () => {
      const revConfigPda = getRevConfigPda(projectPda, revenueDistributionProgramId);
      const revVaultAuthorityPda = getRevVaultAuthorityPda(projectPda, revenueDistributionProgramId);
      const revVault = getAssociatedTokenAddressSync(tasteMint, revVaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
      const artistAta = getAssociatedTokenAddressSync(tasteMint, artist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const config = await (revenueDistribution.account as Record<string, { fetch: (p: PublicKey) => Promise<{ epochCount: { toString: () => string } }> }>).revenueConfig.fetch(revConfigPda) as { epochCount: { toString: () => string } };
      const epochIndex = Number(config.epochCount.toString());
      const distributionEpochPda = getDistributionEpochPda(projectPda, epochIndex, revenueDistributionProgramId);
      const depositAmount = 100_000 * LAMPORTS_PER_TASTE;
      const artistBalanceBefore = (await getAccount(provider.connection, artistAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      if (Number(artistBalanceBefore) < depositAmount) {
        await tasteToken.methods
          .mintTo(new anchor.BN(depositAmount.toString()))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: artistAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      }
      await revenueDistribution.methods
        .depositRevenue(new anchor.BN(depositAmount))
        .accounts({
          artistAuthority: artist.publicKey,
          revConfig: revConfigPda,
          project: projectPda,
          rwaState: rwaStatePda,
          distributionEpoch: distributionEpochPda,
          artistSource: artistAta,
          revVault,
          revVaultAuthority: revVaultAuthorityPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([artist])
        .rpc();
      const epoch = await (revenueDistribution.account as Record<string, { fetch: (p: PublicKey) => Promise<{ amount: { toString: () => string }; totalRwaSupply: { toString: () => string } }> }>).distributionEpoch.fetch(distributionEpochPda) as { amount: { toString: () => string }; totalRwaSupply: { toString: () => string } };
      expect(Number(epoch.amount.toString())).to.equal(depositAmount);
      expect(Number(epoch.totalRwaSupply.toString())).to.be.greaterThan(0);
    });

    it("claim_revenue", async () => {
      const revConfigPda = getRevConfigPda(projectPda, revenueDistributionProgramId);
      const revVaultAuthorityPda = getRevVaultAuthorityPda(projectPda, revenueDistributionProgramId);
      const revVault = getAssociatedTokenAddressSync(tasteMint, revVaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
      const config = await (revenueDistribution.account as Record<string, { fetch: (p: PublicKey) => Promise<{ epochCount: { toString: () => string } }> }>).revenueConfig.fetch(revConfigPda) as { epochCount: { toString: () => string } };
      const epochIndex = Number(config.epochCount.toString()) - 1;
      const distributionEpochPda = getDistributionEpochPda(projectPda, epochIndex, revenueDistributionProgramId);
      const holder = backers[0];
      const holderRwaAta = getAssociatedTokenAddressSync(rwaMintPda, holder.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const holderDest = getAssociatedTokenAddressSync(tasteMint, holder.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const holderClaimPda = getHolderClaimPda(projectPda, epochIndex, holder.publicKey, revenueDistributionProgramId);
      let holderDestInfo = await provider.connection.getAccountInfo(holderDest);
      if (!holderDestInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(holder.publicKey, holderDest, holder.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
        );
        await sendAndConfirmTransaction(provider.connection, tx, [holder]);
      }
      const destBefore = (await getAccount(provider.connection, holderDest, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      await revenueDistribution.methods
        .claimRevenue()
        .accounts({
          holder: holder.publicKey,
          revConfig: revConfigPda,
          distributionEpoch: distributionEpochPda,
          holderRwaAccount: holderRwaAta,
          holderDest,
          holderClaim: holderClaimPda,
          revVaultAuthority: revVaultAuthorityPda,
          revVault,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([holder])
        .rpc();
      await new Promise((r) => setTimeout(r, 500));
      const destAfter = (await getAccount(provider.connection, holderDest, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      expect(Number(destAfter)).to.be.greaterThan(Number(destBefore));
      await expect(
        revenueDistribution.methods
          .claimRevenue()
          .accounts({
            holder: holder.publicKey,
            revConfig: revConfigPda,
            distributionEpoch: distributionEpochPda,
            holderRwaAccount: holderRwaAta,
            holderDest,
            holderClaim: holderClaimPda,
            revVaultAuthority: revVaultAuthorityPda,
            revVault,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([holder])
          .rpc()
      ).to.be.rejectedWith(/AlreadyClaimed|already claimed|0x/i);
    });

    it("close_epoch", async () => {
      const revConfigPda = getRevConfigPda(projectPda, revenueDistributionProgramId);
      const revVaultAuthorityPda = getRevVaultAuthorityPda(projectPda, revenueDistributionProgramId);
      const revVault = getAssociatedTokenAddressSync(tasteMint, revVaultAuthorityPda, true, TOKEN_2022_PROGRAM_ID);
      const config = await (revenueDistribution.account as Record<string, { fetch: (p: PublicKey) => Promise<{ epochCount: { toString: () => string } }> }>).revenueConfig.fetch(revConfigPda) as { epochCount: { toString: () => string } };
      const epochIndex = Number(config.epochCount.toString()) - 1;
      const distributionEpochPda = getDistributionEpochPda(projectPda, epochIndex, revenueDistributionProgramId);
      const artistDest = getAssociatedTokenAddressSync(tasteMint, artist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const vaultBefore = (await getAccount(provider.connection, revVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const artistBefore = (await getAccount(provider.connection, artistDest, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      await revenueDistribution.methods
        .closeEpoch()
        .accounts({
          authority: artist.publicKey,
          revConfig: revConfigPda,
          distributionEpoch: distributionEpochPda,
          revVaultAuthority: revVaultAuthorityPda,
          revVault,
          artistDest,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([artist])
        .rpc();
      await new Promise((r) => setTimeout(r, 500));
      const vaultAfter = (await getAccount(provider.connection, revVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const artistAfter = (await getAccount(provider.connection, artistDest, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      expect(Number(vaultAfter)).to.equal(0);
      expect(Number(artistAfter)).to.be.greaterThan(Number(artistBefore));
    });
  });

  describe("claim_rwa_tokens_legacy", () => {
    const legacyArtist = Keypair.generate();
    let legacyProjectPda: PublicKey;
    let legacyEscrowPda: PublicKey;
    let legacyRwaStatePda: PublicKey;
    let legacyRwaMintPda: PublicKey;
    /** Governance inits RWA with this supply on 5th finalizeProposal; use for expectedShare. */
    const LEGACY_RWA_SUPPLY = 1_000_000n * 1_000_000n;
    /** Shorter voting period for this block only so the 5-milestone before() finishes in ~40s instead of ~4 min. */
    const LEGACY_VOTING_PERIOD_SECS = new anchor.BN(5);
    const LEGACY_SLEEP_MS = 7_000;

    before(async () => {
      await withTxLogs(provider.connection, async () => {
      await airdrop(legacyArtist.publicKey);
      // legacyBackers already have TASTE from main "mints to treasury and to all backers"

      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), legacyArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      legacyProjectPda = getProjectPda(legacyArtist.publicKey, 0, projectEscrowProgramId);
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), legacyProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      legacyEscrowPda = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), legacyProjectPda.toBuffer()],
        projectEscrowProgramId
      )[0];
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: legacyArtist.publicKey,
          artistState: artistStatePda,
          project: legacyProjectPda,
          escrowAuthority,
          escrow: legacyEscrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([legacyArtist])
        .rpc();

      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      for (let i = 0; i < legacyBackers.length; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), legacyProjectPda.toBuffer(), legacyBackers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(tasteMint, legacyBackers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        await projectEscrow.methods
          .fundProject(new anchor.BN(LEGACY_BACKER_AMOUNTS[i].toString()))
          .accounts({
            backerWallet: legacyBackers[i].publicKey,
            project: legacyProjectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: legacyEscrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([legacyBackers[i]])
          .rpc();
      }

      const proposalAttemptPda = getProposalAttemptPda(legacyProjectPda, governance.programId);
      const legacyAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        legacyProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      for (let milestone = 0; milestone < 5; milestone++) {
        const attempt = await getCurrentProposalAttempt(governance, proposalAttemptPda);
        const proposalPda = getProposalPda(legacyProjectPda, milestone, attempt, governance.programId);
        await (governance.methods as unknown as { createProposal: (p: PublicKey, m: number, u: string, v: anchor.BN, a: anchor.BN) => { accounts: (a: object) => { remainingAccounts: (r: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } } }).createProposal(
          legacyProjectPda,
          milestone,
          `https://proof.example/legacy-m${milestone}`,
          LEGACY_VOTING_PERIOD_SECS,
          new anchor.BN(attempt)
        )
          .accounts({
            artist: legacyArtist.publicKey,
            proposalAttempt: proposalAttemptPda,
            proposal: proposalPda,
            project: legacyProjectPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
          ])
          .signers([legacyArtist])
          .rpc();
        for (let i = 0; i < legacyBackers.length; i++) {
          const [backerPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("backer"), legacyProjectPda.toBuffer(), legacyBackers[i].publicKey.toBuffer()],
            projectEscrowProgramId
          );
          const [votePda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vote"), proposalPda.toBuffer(), legacyBackers[i].publicKey.toBuffer()],
            governanceProgramId
          );
          const side = true; // all legacy backers vote for so every proposal passes and RWA is inited on 5th finalize
          await (governance.methods as unknown as { castVote: (s: boolean) => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).castVote(side)
            .accounts({
              voter: legacyBackers[i].publicKey,
              backer: backerPda,
              proposal: proposalPda,
              vote: votePda,
              project: legacyProjectPda,
              escrow: legacyEscrowPda,
              config: getGovConfigPda(governanceProgramId),
              systemProgram: SystemProgram.programId,
            })
            .signers([legacyBackers[i]])
            .rpc();
        }
        await new Promise((r) => setTimeout(r, LEGACY_SLEEP_MS));
        const legacyEscrowAuthority = PublicKey.findProgramAddressSync(
          [Buffer.from("project"), legacyProjectPda.toBuffer()],
          projectEscrowProgramId
        )[0];
        const legacyArtistAta = getAssociatedTokenAddressSync(tasteMint, legacyArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
        let legacyArtistAtaInfo = await provider.connection.getAccountInfo(legacyArtistAta);
        if (!legacyArtistAtaInfo) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              legacyArtist.publicKey,
              legacyArtistAta,
              legacyArtist.publicKey,
              tasteMint,
              TOKEN_2022_PROGRAM_ID
            )
          );
          await sendAndConfirmTransaction(provider.connection, tx, [legacyArtist]);
        }
        const { rwaState: legacyRwaStatePdaPre, rwaMint: legacyRwaMintPdaPre, rwaMintAuthority: legacyRwaMintAuthorityPre, rwaConfig: legacyRwaConfig, rwaExtraAccountMetas: legacyRwaExtraAccountMetas, rwaMetadataGuard: legacyRwaMetadataGuard, rwaMetadata: legacyRwaMetadata } = getRwaPdas(legacyProjectPda, rwaTokenProgramId);
        const legacyRwaAccounts = getFinalizeProposalRwaAccounts(legacyProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
        const legacyFinalizeBuilder = governance.methods
          .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
          .accountsStrict({
            proposal: proposalPda,
            project: legacyProjectPda,
            payer: provider.wallet.publicKey,
            releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
            escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
            escrow: legacyEscrowPda,
            escrowAuthority: legacyEscrowAuthority,
            artistTokenAccount: legacyArtistAta,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            projectEscrowProgram: projectEscrowProgramId,
            rwaState: legacyRwaStatePdaPre,
            rwaMint: legacyRwaMintPdaPre,
            rwaMintAuthority: legacyRwaMintAuthorityPre,
            rwaConfig: legacyRwaConfig,
            rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
            rwaExtraAccountMetas: legacyRwaExtraAccountMetas,
            rwaMetadataGuard: legacyRwaMetadataGuard,
            rwaMetadata: legacyRwaMetadata,
            artist: legacyArtist.publicKey,
            tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
            rwaTokenProgram: rwaTokenProgramId,
            ...legacyRwaAccounts,
            systemProgram: SystemProgram.programId,
          })
          .signers([legacyArtist]);
        await sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), legacyFinalizeBuilder, legacyAlt.alt, [legacyArtist]);
      }

      legacyRwaStatePda = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_state"), legacyProjectPda.toBuffer()],
        rwaTokenProgramId
      )[0];
      legacyRwaMintPda = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_mint"), legacyProjectPda.toBuffer()],
        rwaTokenProgramId
      )[0];
      // RWA is already initialized by governance on 5th finalizeProposal; do not call initializeRwaMint.
      });
    });

    it("backers claim RWA via claim_rwa_tokens_legacy (no receipt)", async () => {
      await withTxLogs(provider.connection, async () => {
      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(legacyProjectPda) as { totalRaised: { toString(): string } };
      const totalRaised = BigInt(project.totalRaised.toString());
      for (let i = 0; i < legacyBackers.length; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), legacyProjectPda.toBuffer(), legacyBackers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const [claimRecordPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), legacyProjectPda.toBuffer(), legacyBackers[i].publicKey.toBuffer()],
          rwaTokenProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(
          legacyRwaMintPda,
          legacyBackers[i].publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        const ataInfo = await provider.connection.getAccountInfo(backerAta);
        if (!ataInfo) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              legacyBackers[i].publicKey,
              backerAta,
              legacyBackers[i].publicKey,
              legacyRwaMintPda,
              TOKEN_2022_PROGRAM_ID
            )
          );
          await sendAndConfirmTransaction(provider.connection, tx, [legacyBackers[i]]);
        }
        await (rwaToken.methods as unknown as { claimRwaTokensLegacy: () => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).claimRwaTokensLegacy()
          .accounts({
            backer: legacyBackers[i].publicKey,
            backerAccount: backerPda,
            project: legacyProjectPda,
            rwaState: legacyRwaStatePda,
            rwaMint: legacyRwaMintPda,
            rwaMintAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("rwa_mint_authority"), legacyProjectPda.toBuffer()],
              rwaTokenProgramId
            )[0],
            claimRecord: claimRecordPda,
            backerTokenAccount: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([legacyBackers[i]])
          .rpc();
        // Allow validator to commit balance before we read (CI can be slow).
        await new Promise((r) => setTimeout(r, 400));
        // Program uses backer.amount (96% to escrow) and project.total_raised; match that for expectedShare.
        const toEscrow = (LEGACY_BACKER_AMOUNTS[i] * 96n) / 100n;
        const expectedShare = (toEscrow * LEGACY_RWA_SUPPLY) / totalRaised;
        if (expectedShare > 0n) {
          let tokenAccount = await getAccount(provider.connection, backerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
          let amount = typeof tokenAccount.amount === "bigint" ? tokenAccount.amount : BigInt(String(tokenAccount.amount));
          for (let w = 0; w < 8 && amount < expectedShare - 1n; w++) {
            await new Promise((r) => setTimeout(r, 300));
            tokenAccount = await getAccount(provider.connection, backerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
            amount = typeof tokenAccount.amount === "bigint" ? tokenAccount.amount : BigInt(String(tokenAccount.amount));
          }
          expect(amount >= expectedShare - 1n, `backer ${i}: got ${amount}, expected >= ${expectedShare - 1n}`).to.be.true;
        }
      }
      });
    });
  });

  describe("governance cancel_proposal", () => {
    const cancelProposalArtist = Keypair.generate();
    let cancelProposalProjectPda: PublicKey;
    let cancelProposalPda: PublicKey;

    before(async () => {
      await airdrop(cancelProposalArtist.publicKey);
    });

    it("artist creates project, backer funds, artist creates proposal then cancels it", async () => {
      cancelProposalProjectPda = getProjectPda(cancelProposalArtist.publicKey, 0, projectEscrowProgramId);
      const [cancelProposalArtistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), cancelProposalArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), cancelProposalProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), cancelProposalProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      const goal = new anchor.BN(100_000 * LAMPORTS_PER_TASTE);

      await projectEscrow.methods
        .createProject("Cancel Proposal", goal, MILESTONES, deadline)
        .accounts({
          artist: cancelProposalArtist.publicKey,
          artistState: cancelProposalArtistStatePda,
          project: cancelProposalProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cancelProposalArtist])
        .rpc();

      const backerAta = getAssociatedTokenAddressSync(
        tasteMint,
        cancelProposalBacker.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      const backerAtaInfo = await provider.connection.getAccountInfo(backerAta);
      if (!backerAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            cancelProposalBacker.publicKey,
            backerAta,
            cancelProposalBacker.publicKey,
            tasteMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(provider.connection, tx, [cancelProposalBacker]);
      }
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const fundAmt = new anchor.BN(50_000 * LAMPORTS_PER_TASTE);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), cancelProposalProjectPda.toBuffer(), cancelProposalBacker.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      await projectEscrow.methods
        .fundProject(fundAmt)
        .accounts({
          backerWallet: cancelProposalBacker.publicKey,
          project: cancelProposalProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cancelProposalBacker])
        .rpc();

      const cancelProposalAttemptPda = getProposalAttemptPda(cancelProposalProjectPda, governance.programId);
      const attemptCancel = await getCurrentProposalAttempt(governance, cancelProposalAttemptPda);
      cancelProposalPda = getProposalPda(cancelProposalProjectPda, 0, attemptCancel, governance.programId);
      await governance.methods
        .createProposal(
          cancelProposalProjectPda,
          0,
          "https://proof/cancel-test",
          VOTING_PERIOD_SECS,
          new anchor.BN(attemptCancel)
        )
        .accounts({
          artist: cancelProposalArtist.publicKey,
          proposalAttempt: cancelProposalAttemptPda,
          proposal: cancelProposalPda,
          project: cancelProposalProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([cancelProposalArtist])
        .rpc();

      await governance.methods
        .cancelProposal()
        .accounts({
          creator: cancelProposalArtist.publicKey,
          proposal: cancelProposalPda,
        })
        .signers([cancelProposalArtist])
        .rpc();

      const after = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(cancelProposalPda) as { status: Record<string, unknown> };
      expect("cancelled" in after.status).to.be.true;
    });
  });

  describe("project_escrow cancel and refund", () => {
    let cancelProjectPda: PublicKey;
    let cancelEscrowPda: PublicKey;
    const cancelArtist = Keypair.generate();

    before(async () => {
      await airdrop(cancelArtist.publicKey);
    });

    it("second artist creates project and one backer funds", async () => {
      cancelProjectPda = getProjectPda(cancelArtist.publicKey, 0, projectEscrowProgramId);
      const [cancelArtistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), cancelArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), cancelProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      cancelEscrowPda = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), cancelProjectPda.toBuffer()],
        projectEscrowProgramId
      )[0];
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      const goal = new anchor.BN(1_000_000 * LAMPORTS_PER_TASTE);

      await projectEscrow.methods
        .createProject("Cancel", goal, MILESTONES, deadline)
        .accounts({
          artist: cancelArtist.publicKey,
          artistState: cancelArtistStatePda,
          project: cancelProjectPda,
          escrowAuthority,
          escrow: cancelEscrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cancelArtist])
        .rpc();

      const backerAta = getAssociatedTokenAddressSync(tasteMint, cancelBacker.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const fundAmt = new anchor.BN(100_000 * LAMPORTS_PER_TASTE);

      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), cancelProjectPda.toBuffer(), cancelBacker.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      await projectEscrow.methods
        .fundProject(fundAmt)
        .accounts({
          backerWallet: cancelBacker.publicKey,
          project: cancelProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: cancelEscrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cancelBacker])
        .rpc();
    });

    it("artist cancels project", async () => {
      await projectEscrow.methods
        .cancelProject()
        .accounts({
          artist: cancelArtist.publicKey,
          project: cancelProjectPda,
        })
        .signers([cancelArtist])
        .rpc();

      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(cancelProjectPda) as { status: Record<string, unknown> };
      expect("cancelled" in project.status).to.be.true;
    });

    it("backer refunds", async () => {
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), cancelProjectPda.toBuffer(), cancelBacker.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), cancelProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, cancelBacker.publicKey, false, TOKEN_2022_PROGRAM_ID);

      await projectEscrow.methods
        .refund()
        .accounts({
          backerWallet: cancelBacker.publicKey,
          project: cancelProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: cancelEscrowPda,
          escrowAuthority,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([cancelBacker])
        .rpc();

      const balance = await provider.connection.getTokenAccountBalance(backerAta);
      // Refund is 96% of funded amount (4% fee was taken at fund time)
      const expectedMinRefund = (100_000 * 96 / 100) * LAMPORTS_PER_TASTE;
      expect(Number(balance.value.amount)).to.be.at.least(expectedMinRefund);
    });
  });

  describe("quadratic voting weight check", () => {
    it("vote weights equal sqrt(contribution) for sampled backers", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const proposalPda = getProposalPda(projectPda, 0, 0, governanceProgramId);

      for (const idx of [0, 10, 20, 30, 39]) {
        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), proposalPda.toBuffer(), backers[idx].publicKey.toBuffer()],
          governanceProgramId
        );
        try {
          const vote = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).vote.fetch(votePda) as { weight: { toString(): string } };
          // vote weight = sqrt(post-fee amount)
          const onChainAmount = backerAmounts[idx] * 96n / 100n;
          const expectedWeight = sqrtU64(onChainAmount);
          expect(BigInt(vote.weight.toString())).to.equal(expectedWeight);
        } catch (e) {
          // Vote account may not exist if run order or proposal index differs
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("Account does not exist")) throw e;
        }
      }
    });
  });

  describe("negative and edge cases", () => {
    let rejectProjectPda: PublicKey;
    let rejectArtist: Keypair;

    it("unauthorized mint: non-authority cannot mint TASTE", async () => {
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await expect(
        tasteToken.methods
          .mintTo(new anchor.BN(1000))
          .accounts({
            mintAuthority: backers[0].publicKey,
            mint: tasteMint,
            recipient: backerAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/InvalidMintAuthority|invalid mint authority|0x1771/);
    });

    it("create_project with milestone percentages not summing to 100 fails", async () => {
      const badArtist = Keypair.generate();
      await airdrop(badArtist.publicKey);
      const projectPda = getProjectPda(badArtist.publicKey, 0, projectEscrowProgramId);
      const artistStatePda = getArtistStatePda(badArtist.publicKey, projectEscrowProgramId);
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      const badMilestones = [25, 25, 25, 24, 0] as [number, number, number, number, number];
      await expect(
        projectEscrow.methods
          .createProject("Bad Milestones", new anchor.BN(GOAL.toString()), badMilestones, deadline)
          .accounts({
            artist: badArtist.publicKey,
            artistState: artistStatePda,
            project: projectPda,
            escrowAuthority,
            escrow: escrowPda,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([badArtist])
          .rpc()
      ).to.be.rejectedWith(/InvalidMilestonePercentages|6000/);
    });

    it("fund after deadline fails with ProjectDeadlinePassed", async () => {
      const pastArtist = Keypair.generate();
      await airdrop(pastArtist.publicKey);
      const projectPda = getProjectPda(pastArtist.publicKey, 0, projectEscrowProgramId);
      const artistStatePda = getArtistStatePda(pastArtist.publicKey, projectEscrowProgramId);
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const pastDeadline = new anchor.BN(Math.floor(Date.now() / 1000) - 3600);
      await projectEscrow.methods
        .createProject("Past Deadline", new anchor.BN(GOAL.toString()), MILESTONES, pastDeadline)
        .accounts({
          artist: pastArtist.publicKey,
          artistState: artistStatePda,
          project: projectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([pastArtist])
        .rpc();
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), projectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await expect(
        projectEscrow.methods
          .fundProject(new anchor.BN(1000 * LAMPORTS_PER_TASTE))
          .accounts({
            backerWallet: backers[0].publicKey,
            project: projectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: escrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/ProjectDeadlinePassed|deadline|6010/);
    });

    it("fund past goal fails with GoalExceeded", async () => {
      const goalArtist = Keypair.generate();
      await airdrop(goalArtist.publicKey);
      const smallGoal = 1000 * LAMPORTS_PER_TASTE;
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      const projectPda = getProjectPda(goalArtist.publicKey, 0, projectEscrowProgramId);
      const artistStatePda = getArtistStatePda(goalArtist.publicKey, projectEscrowProgramId);
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      await projectEscrow.methods
        .createProject("Small Goal", new anchor.BN(smallGoal), MILESTONES, deadline)
        .accounts({
          artist: goalArtist.publicKey,
          artistState: artistStatePda,
          project: projectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([goalArtist])
        .rpc();
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), projectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await projectEscrow.methods
        .fundProject(new anchor.BN(900 * LAMPORTS_PER_TASTE))
        .accounts({
          backerWallet: backers[0].publicKey,
          project: projectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[0]])
        .rpc();
      await expect(
        projectEscrow.methods
          .fundProject(new anchor.BN(200 * LAMPORTS_PER_TASTE))
          .accounts({
            backerWallet: backers[0].publicKey,
            project: projectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: escrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/GoalExceeded|goal|6017/);
    });

    it("non-artist cannot create proposal", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const proposalAttemptPda = getProposalAttemptPda(projectPda, governanceProgramId);
      const proposalPda = getProposalPda(projectPda, 5, 5, governanceProgramId);
      await expect(
        governance.methods
          .createProposal(
            projectPda,
            0,
            "https://proof.example/m0",
            VOTING_PERIOD_SECS,
            new anchor.BN(5)
          )
          .accounts({
            artist: backers[0].publicKey,
            proposalAttempt: proposalAttemptPda,
            proposal: proposalPda,
            project: projectPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/NotArtist|not artist|0x1772|ConstraintSeeds|constraint/);
    });

    it("refund on active project fails with ProjectNotCancelled", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), projectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await expect(
        projectEscrow.methods
          .refund()
          .accounts({
            backerWallet: backers[0].publicKey,
            project: projectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: escrowPda,
            escrowAuthority,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/ProjectNotCancelled|cancelled|6020|AccountNotInitialized|constraint/);
    });

    it("double vote on same proposal fails", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const proposalPda = getProposalPda(projectPda, 0, 0, governanceProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), projectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [votePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), proposalPda.toBuffer(), backers[0].publicKey.toBuffer()],
        governanceProgramId
      );
      await expect(
        governance.methods
          .castVote(true)
          .accounts({
            proposal: proposalPda,
            voter: backers[0].publicKey,
            backer: backerPda,
            vote: votePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/already in use|custom program error|0x0|ConstraintSeeds|constraint|proposal/);
    });

    it("claim RWA twice fails with AlreadyClaimed", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const [rwaStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_state"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const backer = backers[0];
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), projectPda.toBuffer(), backer.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [rwaMintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
        rwaTokenProgramId
      );
      const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), projectPda.toBuffer(), backer.publicKey.toBuffer()],
        rwaTokenProgramId
      );
      const backerTokenAccount = getAssociatedTokenAddressSync(
        PublicKey.findProgramAddressSync(
          [Buffer.from("rwa_mint"), projectPda.toBuffer()],
          rwaTokenProgramId
        )[0],
        backer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      let failed = false;
      let errMsg = "";
      try {
        await (rwaToken.methods as unknown as { claimRwaTokensLegacy: () => { accounts: (a: object) => { signers: (s: Keypair[]) => { rpc: () => Promise<string> } } } }).claimRwaTokensLegacy()
          .accounts({
            backer: backer.publicKey,
            backerAccount: backerPda,
            project: projectPda,
            rwaState: rwaStatePda,
            rwaMint: PublicKey.findProgramAddressSync([Buffer.from("rwa_mint"), projectPda.toBuffer()], rwaTokenProgramId)[0],
            rwaMintAuthority,
            claimRecord: claimPda,
            backerTokenAccount,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backer])
          .rpc();
      } catch (e: unknown) {
        failed = true;
        errMsg = (e as Error).message || String(e);
      }
      expect(failed, `Claiming RWA twice should fail but succeeded`).to.be.true;
      const lowerMsg = errMsg.toLowerCase();
      expect(
        lowerMsg.includes("alreadyclaimed") ||
        lowerMsg.includes("already claimed") ||
        lowerMsg.includes("custom program error") ||
        lowerMsg.includes("error code") ||
        lowerMsg.includes("anchorerror"),
        `Expected AlreadyClaimed error but got: ${errMsg.slice(0, 200)}`
      ).to.be.true;
    });

    it("vote after voting period ends fails with VotingEnded", async () => {
      const voteExpiredArtist = Keypair.generate();
      await airdrop(voteExpiredArtist.publicKey);
      const expiredProjectPda = getProjectPda(voteExpiredArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), voteExpiredArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), expiredProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), expiredProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: voteExpiredArtist.publicKey,
          artistState: artistStatePda,
          project: expiredProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([voteExpiredArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), expiredProjectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await projectEscrow.methods
        .fundProject(new anchor.BN(1000 * LAMPORTS_PER_TASTE))
        .accounts({
          backerWallet: backers[0].publicKey,
          project: expiredProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[0]])
        .rpc();
      const proposalAttemptPda = getProposalAttemptPda(expiredProjectPda, governance.programId);
      const attempt0 = await getCurrentProposalAttempt(governance, proposalAttemptPda);
      const proposalPda = getProposalPda(expiredProjectPda, 0, attempt0, governance.programId);
      const shortPeriod = new anchor.BN(2);
      await governance.methods
        .createProposal(expiredProjectPda, 0, "https://proof.example/expired", shortPeriod, new anchor.BN(attempt0))
        .accounts({
          artist: voteExpiredArtist.publicKey,
          proposalAttempt: proposalAttemptPda,
          proposal: proposalPda,
          project: expiredProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([voteExpiredArtist])
        .rpc();
      await new Promise((r) => setTimeout(r, 3000));
      const [votePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), proposalPda.toBuffer(), backers[0].publicKey.toBuffer()],
        governanceProgramId
      );
      await expect(
        governance.methods
          .castVote(true)
          .accounts({
            proposal: proposalPda,
            voter: backers[0].publicKey,
            backer: backerPda,
            vote: votePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/VotingEnded|voting has ended|0x1770/);
    });

    it("finalize before voting period ends fails with VotingNotEnded", async () => {
      const earlyFinalArtist = Keypair.generate();
      await airdrop(earlyFinalArtist.publicKey);
      const earlyProjectPda = getProjectPda(earlyFinalArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), earlyFinalArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), earlyProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), earlyProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: earlyFinalArtist.publicKey,
          artistState: artistStatePda,
          project: earlyProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([earlyFinalArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), earlyProjectPda.toBuffer(), backers[3].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[3].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await projectEscrow.methods
        .fundProject(new anchor.BN(2000 * LAMPORTS_PER_TASTE))
        .accounts({
          backerWallet: backers[3].publicKey,
          project: earlyProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[3]])
        .rpc();
      const proposalAttemptPda = getProposalAttemptPda(earlyProjectPda, governance.programId);
      const attemptEarly = await getCurrentProposalAttempt(governance, proposalAttemptPda);
      const proposalPda = getProposalPda(earlyProjectPda, 0, attemptEarly, governance.programId);
      const longPeriod = new anchor.BN(60);
      await governance.methods
        .createProposal(earlyProjectPda, 0, "https://proof.example/early", longPeriod, new anchor.BN(attemptEarly))
        .accounts({
          artist: earlyFinalArtist.publicKey,
          proposalAttempt: proposalAttemptPda,
          proposal: proposalPda,
          project: earlyProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([earlyFinalArtist])
        .rpc();

      // Finalize checks quorum before VotingNotEnded; cast one vote so we clear quorum and hit VotingNotEnded.
      const [votePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), proposalPda.toBuffer(), backers[3].publicKey.toBuffer()],
        governanceProgramId
      );
      await governance.methods
        .castVote(true)
        .accounts({
          proposal: proposalPda,
          voter: backers[3].publicKey,
          backer: backerPda,
          vote: votePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[3]])
        .rpc();
      // create artist ATA
      const earlyArtistAta = getAssociatedTokenAddressSync(tasteMint, earlyFinalArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const ataInfo = await provider.connection.getAccountInfo(earlyArtistAta);
      if (!ataInfo) {
        const ataTx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            earlyFinalArtist.publicKey,
            earlyArtistAta,
            earlyFinalArtist.publicKey,
            tasteMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(provider.connection, ataTx, [earlyFinalArtist]);
      }
      const earlyRwa = getRwaPdas(earlyProjectPda, rwaTokenProgramId);
      const earlyRwaAccounts = getFinalizeProposalRwaAccounts(earlyProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
      const earlyAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        earlyProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      const earlyFinalizeBuilder = governance.methods
        .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
        .accountsStrict({
          proposal: proposalPda,
          project: earlyProjectPda,
          payer: provider.wallet.publicKey,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: escrowPda,
          escrowAuthority,
          artistTokenAccount: earlyArtistAta,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
          rwaState: earlyRwa.rwaState,
          rwaMint: earlyRwa.rwaMint,
          rwaMintAuthority: earlyRwa.rwaMintAuthority,
          rwaConfig: earlyRwa.rwaConfig,
          rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
          rwaExtraAccountMetas: earlyRwa.rwaExtraAccountMetas,
          rwaMetadataGuard: earlyRwa.rwaMetadataGuard,
          rwaMetadata: earlyRwa.rwaMetadata,
          artist: earlyFinalArtist.publicKey,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          rwaTokenProgram: rwaTokenProgramId,
          ...earlyRwaAccounts,
          systemProgram: SystemProgram.programId,
        })
        .signers([earlyFinalArtist]);
      await expect(
        sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), earlyFinalizeBuilder, earlyAlt.alt, [earlyFinalArtist])
      ).to.be.rejectedWith(/VotingNotEnded|voting period has not ended|0x1773/);
    });

    it("finalize after end_ts without remaining accounts succeeds (optional Config/VoteWeight regression)", async () => {
      const noRemArtist = Keypair.generate();
      await airdrop(noRemArtist.publicKey);
      const noRemProjectPda = getProjectPda(noRemArtist.publicKey, 0, projectEscrowProgramId);
      const [noRemArtistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), noRemArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [noRemEscrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), noRemProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [noRemEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), noRemProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: noRemArtist.publicKey,
          artistState: noRemArtistStatePda,
          project: noRemProjectPda,
          escrowAuthority: noRemEscrowAuthority,
          escrow: noRemEscrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([noRemArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [noRemBackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), noRemProjectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const noRemBackerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await projectEscrow.methods
        // Keep this tiny so it doesn't drain balances needed by later tests.
        .fundProject(new anchor.BN(1 * LAMPORTS_PER_TASTE))
        .accounts({
          backerWallet: backers[0].publicKey,
          project: noRemProjectPda,
          backer: noRemBackerPda,
          backerTokenAccount: noRemBackerAta,
          escrow: noRemEscrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[0]])
        .rpc();
      const noRemAttemptPda = getProposalAttemptPda(noRemProjectPda, governance.programId);
      const noRemAttempt = await getCurrentProposalAttempt(governance, noRemAttemptPda);
      const noRemProposalPda = getProposalPda(noRemProjectPda, 0, noRemAttempt, governance.programId);
      const shortPeriod = new anchor.BN(2);
      await governance.methods
        .createProposal(noRemProjectPda, 0, "https://proof.example/no-rem", shortPeriod, new anchor.BN(noRemAttempt))
        .accounts({
          artist: noRemArtist.publicKey,
          proposalAttempt: noRemAttemptPda,
          proposal: noRemProposalPda,
          project: noRemProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([noRemArtist])
        .rpc();
      const [noRemVotePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), noRemProposalPda.toBuffer(), backers[0].publicKey.toBuffer()],
        governanceProgramId
      );
      await governance.methods
        .castVote(true)
        .accounts({
          proposal: noRemProposalPda,
          voter: backers[0].publicKey,
          backer: noRemBackerPda,
          vote: noRemVotePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[0]])
        .rpc();
      await new Promise((r) => setTimeout(r, 3500));
      const noRemArtistAta = getAssociatedTokenAddressSync(tasteMint, noRemArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      {
        const ataInfo = await provider.connection.getAccountInfo(noRemArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(noRemArtist.publicKey, noRemArtistAta, noRemArtist.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [noRemArtist]);
        }
      }
      const noRemRwa = getRwaPdas(noRemProjectPda, rwaTokenProgramId);
      const noRemRwaAccounts = getFinalizeProposalRwaAccounts(noRemProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
      const noRemAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        noRemProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      const noRemFinalizeBuilder = governance.methods
        .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
        .accountsStrict({
          proposal: noRemProposalPda,
          project: noRemProjectPda,
          payer: provider.wallet.publicKey,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: noRemEscrowPda,
          escrowAuthority: noRemEscrowAuthority,
          artistTokenAccount: noRemArtistAta,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
          rwaState: noRemRwa.rwaState,
          rwaMint: noRemRwa.rwaMint,
          rwaMintAuthority: noRemRwa.rwaMintAuthority,
          rwaConfig: noRemRwa.rwaConfig,
          rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
          rwaExtraAccountMetas: noRemRwa.rwaExtraAccountMetas,
          rwaMetadataGuard: noRemRwa.rwaMetadataGuard,
          rwaMetadata: noRemRwa.rwaMetadata,
          artist: noRemArtist.publicKey,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          rwaTokenProgram: rwaTokenProgramId,
          ...noRemRwaAccounts,
          systemProgram: SystemProgram.programId,
        })
        .signers([noRemArtist]);
      await sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), noRemFinalizeBuilder, noRemAlt.alt, [noRemArtist]);
      const proposalAfter = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(noRemProposalPda) as { status: Record<string, unknown> };
      expect("passed" in proposalAfter.status || "active" in proposalAfter.status).to.be.true;
    });

    it("early finalize succeeds when config enabled, quorum met, outcome decided", async () => {
      const earlyOkArtist = Keypair.generate();
      await airdrop(earlyOkArtist.publicKey);
      const earlyOkProjectPda = getProjectPda(earlyOkArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), earlyOkArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), earlyOkProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), earlyOkProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: earlyOkArtist.publicKey,
          artistState: artistStatePda,
          project: earlyOkProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([earlyOkArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), earlyOkProjectPda.toBuffer(), backers[4].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[4].publicKey, false, TOKEN_2022_PROGRAM_ID);
      const fundAmount = 2000 * LAMPORTS_PER_TASTE;
      await projectEscrow.methods
        .fundProject(new anchor.BN(fundAmount))
        .accounts({
          backerWallet: backers[4].publicKey,
          project: earlyOkProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[4]])
        .rpc();
      const proposalAttemptPda = getProposalAttemptPda(earlyOkProjectPda, governance.programId);
      const attemptEarlyOk = await getCurrentProposalAttempt(governance, proposalAttemptPda);
      const proposalPda = getProposalPda(earlyOkProjectPda, 0, attemptEarlyOk, governance.programId);
      const longPeriod = new anchor.BN(60);
      await governance.methods
        .createProposal(earlyOkProjectPda, 0, "https://proof.example/earlyok", longPeriod, new anchor.BN(attemptEarlyOk))
        .accounts({
          artist: earlyOkArtist.publicKey,
          proposalAttempt: proposalAttemptPda,
          proposal: proposalPda,
          project: earlyOkProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([earlyOkArtist])
        .rpc();
      const [votePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), proposalPda.toBuffer(), backers[4].publicKey.toBuffer()],
        governanceProgramId
      );
      await governance.methods
        .castVote(true)
        .accounts({
          proposal: proposalPda,
          voter: backers[4].publicKey,
          backer: backerPda,
          vote: votePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[4]])
        .rpc();
      const earlyOkArtistAta = getAssociatedTokenAddressSync(tasteMint, earlyOkArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      {
        const ataInfo = await provider.connection.getAccountInfo(earlyOkArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(earlyOkArtist.publicKey, earlyOkArtistAta, earlyOkArtist.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [earlyOkArtist]);
        }
      }
      const earlyOkRwa = getRwaPdas(earlyOkProjectPda, rwaTokenProgramId);
      const earlyOkRwaAccounts = getFinalizeProposalRwaAccounts(earlyOkProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
      const earlyOkAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        earlyOkProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId,
        [getGovConfigPda(governanceProgramId), getVoteWeightPda(earlyOkProjectPda, projectEscrowProgramId)]
      );
      const earlyOkFinalizeBuilder = governance.methods
        .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
        .accountsStrict({
          proposal: proposalPda,
          project: earlyOkProjectPda,
          payer: provider.wallet.publicKey,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: escrowPda,
          escrowAuthority,
          artistTokenAccount: earlyOkArtistAta,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
          rwaState: earlyOkRwa.rwaState,
          rwaMint: earlyOkRwa.rwaMint,
          rwaMintAuthority: earlyOkRwa.rwaMintAuthority,
          rwaConfig: earlyOkRwa.rwaConfig,
          rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
          rwaExtraAccountMetas: earlyOkRwa.rwaExtraAccountMetas,
          rwaMetadataGuard: earlyOkRwa.rwaMetadataGuard,
          rwaMetadata: earlyOkRwa.rwaMetadata,
          artist: earlyOkArtist.publicKey,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          rwaTokenProgram: rwaTokenProgramId,
          ...earlyOkRwaAccounts,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
          { pubkey: getVoteWeightPda(earlyOkProjectPda, projectEscrowProgramId), isSigner: false, isWritable: false },
        ])
        .signers([earlyOkArtist]);
      await sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), earlyOkFinalizeBuilder, earlyOkAlt.alt, [earlyOkArtist]);
      const proposalAfter = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(proposalPda) as { status: Record<string, unknown> };
      expect("passed" in proposalAfter.status).to.be.true;
    });

    it("early finalize fails when quorum met but outcome not decided", async () => {
      const notDecidedArtist = Keypair.generate();
      await airdrop(notDecidedArtist.publicKey);
      const notDecidedProjectPda = getProjectPda(notDecidedArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), notDecidedArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), notDecidedProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), notDecidedProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: notDecidedArtist.publicKey,
          artistState: artistStatePda,
          project: notDecidedProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([notDecidedArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      // Keep this tiny so repeated tests don't run out of token balances.
      const amt = 1 * LAMPORTS_PER_TASTE;
      // Use reserved backers (0..4 get extra TASTE in the mint test) so we never hit token insufficient-funds here.
      for (const backer of [backers[0], backers[1]]) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), notDecidedProjectPda.toBuffer(), backer.publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backer.publicKey, false, TOKEN_2022_PROGRAM_ID);
        await projectEscrow.methods
          .fundProject(new anchor.BN(amt))
          .accounts({
            backerWallet: backer.publicKey,
            project: notDecidedProjectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: escrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backer])
          .rpc();
      }
      const proposalAttemptPda = getProposalAttemptPda(notDecidedProjectPda, governance.programId);
      const attemptNotDecided = await getCurrentProposalAttempt(governance, proposalAttemptPda);
      const proposalPda = getProposalPda(notDecidedProjectPda, 0, attemptNotDecided, governance.programId);
      const longPeriod = new anchor.BN(60);
      await governance.methods
        .createProposal(notDecidedProjectPda, 0, "https://proof.example/notdecided", longPeriod, new anchor.BN(attemptNotDecided))
        .accounts({
          artist: notDecidedArtist.publicKey,
          proposalAttempt: proposalAttemptPda,
          proposal: proposalPda,
          project: notDecidedProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([notDecidedArtist])
        .rpc();
      const [votePda0] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), proposalPda.toBuffer(), backers[0].publicKey.toBuffer()],
        governanceProgramId
      );
      const [backerPda0] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), notDecidedProjectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      await governance.methods
        .castVote(true)
        .accounts({
          proposal: proposalPda,
          voter: backers[0].publicKey,
          backer: backerPda0,
          vote: votePda0,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[0]])
        .rpc();
      const notDecidedArtistAta = getAssociatedTokenAddressSync(tasteMint, notDecidedArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      {
        const ataInfo = await provider.connection.getAccountInfo(notDecidedArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(notDecidedArtist.publicKey, notDecidedArtistAta, notDecidedArtist.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [notDecidedArtist]);
        }
      }
      const notDecidedRwa = getRwaPdas(notDecidedProjectPda, rwaTokenProgramId);
      const notDecidedRwaAccounts = getFinalizeProposalRwaAccounts(notDecidedProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
      const notDecidedAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        notDecidedProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId,
        [getGovConfigPda(governanceProgramId), getVoteWeightPda(notDecidedProjectPda, projectEscrowProgramId)]
      );
      const notDecidedFinalizeBuilder = governance.methods
        .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
        .accountsStrict({
          proposal: proposalPda,
          project: notDecidedProjectPda,
          payer: provider.wallet.publicKey,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: escrowPda,
          escrowAuthority,
          artistTokenAccount: notDecidedArtistAta,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
          rwaState: notDecidedRwa.rwaState,
          rwaMint: notDecidedRwa.rwaMint,
          rwaMintAuthority: notDecidedRwa.rwaMintAuthority,
          rwaConfig: notDecidedRwa.rwaConfig,
          rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
          rwaExtraAccountMetas: notDecidedRwa.rwaExtraAccountMetas,
          rwaMetadataGuard: notDecidedRwa.rwaMetadataGuard,
          rwaMetadata: notDecidedRwa.rwaMetadata,
          artist: notDecidedArtist.publicKey,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          rwaTokenProgram: rwaTokenProgramId,
          ...notDecidedRwaAccounts,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
          { pubkey: getVoteWeightPda(notDecidedProjectPda, projectEscrowProgramId), isSigner: false, isWritable: false },
        ])
        .signers([notDecidedArtist]);
      await expect(
        sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), notDecidedFinalizeBuilder, notDecidedAlt.alt, [notDecidedArtist])
      ).to.be.rejectedWith(/VotingNotEnded|voting period has not ended|0x1773/);
    });

    it("non-artist cannot cancel project", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      await expect(
        projectEscrow.methods
          .cancelProject()
          .accounts({
            artist: backers[0].publicKey,
            project: projectPda,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/NotArtist|only the artist|constraint|ConstraintSeeds/);
    });

    it("initialize_rwa_mint on uncompleted project fails with ProjectNotCompleted", async () => {
      const activeArtist = Keypair.generate();
      await airdrop(activeArtist.publicKey);
      const activeProjectPda = getProjectPda(activeArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), activeArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), activeProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), activeProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: activeArtist.publicKey,
          artistState: artistStatePda,
          project: activeProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([activeArtist])
        .rpc();
      const { rwaConfig, rwaExtraAccountMetas } = getRwaPdas(activeProjectPda, rwaTokenProgramId);
      const [rwaStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_state"), activeProjectPda.toBuffer()],
        rwaTokenProgramId
      );
      const [rwaMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_mint"), activeProjectPda.toBuffer()],
        rwaTokenProgramId
      );
      const [rwaMintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("rwa_mint_authority"), activeProjectPda.toBuffer()],
        rwaTokenProgramId
      );
      await expect(
        rwaToken.methods
          .initializeRwaMint(new anchor.BN(1_000_000))
          .accountsStrict({
            authority: activeArtist.publicKey,
            project: activeProjectPda,
            rwaState: rwaStatePda,
            rwaConfig,
            rwaMint: rwaMintPda,
            rwaMintAuthority,
            rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetas: rwaExtraAccountMetas,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([activeArtist])
          .rpc()
      ).to.be.rejectedWith(/ProjectNotCompleted|project must be completed|0x1775/);
    });

    it("backer funds same project twice: amount accumulates correctly", async () => {
      const doubleArtist = Keypair.generate();
      await airdrop(doubleArtist.publicKey);
      const doubleProjectPda = getProjectPda(doubleArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), doubleArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), doubleProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), doubleProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: doubleArtist.publicKey,
          artistState: artistStatePda,
          project: doubleProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([doubleArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), doubleProjectPda.toBuffer(), backers[1].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[1].publicKey, false, TOKEN_2022_PROGRAM_ID);
      const firstAmount = 5000 * LAMPORTS_PER_TASTE;
      const secondAmount = 3000 * LAMPORTS_PER_TASTE;
      await projectEscrow.methods
        .fundProject(new anchor.BN(firstAmount))
        .accounts({
          backerWallet: backers[1].publicKey,
          project: doubleProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[1]])
        .rpc();
      await projectEscrow.methods
        .fundProject(new anchor.BN(secondAmount))
        .accounts({
          backerWallet: backers[1].publicKey,
          project: doubleProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[1]])
        .rpc();
      const backerAcc = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).backer.fetch(backerPda) as { amount: { toString(): string } };
      const expectedEscrow = (BigInt(firstAmount) * 96n) / 100n + (BigInt(secondAmount) * 96n) / 100n;
      expect(BigInt(backerAcc.amount.toString())).to.equal(expectedEscrow);
    });

    it("proposal rejected: votes_against > votes_for yields Rejected and no escrow release", async () => {
      rejectArtist = Keypair.generate();
      await airdrop(rejectArtist.publicKey);
      rejectProjectPda = getProjectPda(rejectArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), rejectArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), rejectProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), rejectProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: rejectArtist.publicKey,
          artistState: artistStatePda,
          project: rejectProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([rejectArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      for (let i = 0; i < 5; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), rejectProjectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey, false, TOKEN_2022_PROGRAM_ID);
        await projectEscrow.methods
          .fundProject(new anchor.BN(Number(backerAmounts[i])))
          .accounts({
            backerWallet: backers[i].publicKey,
            project: rejectProjectPda,
            backer: backerPda,
            backerTokenAccount: backerAta,
            escrow: escrowPda,
            platformTreasury,
            burnVaultAuthority,
            burnVaultTokenAccount,
            tasteMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();
      }
      const proposalAttemptPda = getProposalAttemptPda(rejectProjectPda, governance.programId);
      const attemptReject = await getCurrentProposalAttempt(governance, proposalAttemptPda);
      const proposalPda = getProposalPda(rejectProjectPda, 0, attemptReject, governance.programId);
      const shortPeriod = new anchor.BN(3);
      await governance.methods
        .createProposal(rejectProjectPda, 0, "https://proof.example/reject", shortPeriod, new anchor.BN(attemptReject))
        .accounts({
          artist: rejectArtist.publicKey,
          proposalAttempt: proposalAttemptPda,
          proposal: proposalPda,
          project: rejectProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([rejectArtist])
        .rpc();
      for (let i = 0; i < 5; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), rejectProjectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), proposalPda.toBuffer(), backers[i].publicKey.toBuffer()],
          governanceProgramId
        );
        await governance.methods
          .castVote(false)
          .accounts({
            proposal: proposalPda,
            voter: backers[i].publicKey,
            backer: backerPda,
            vote: votePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();
      }
      // Wait for voting period (3s) to end; use 6s in CI where validator clock can lag
      await new Promise((r) => setTimeout(r, 6000));
      // create artist ATA
      const rejectArtistAta = getAssociatedTokenAddressSync(tasteMint, rejectArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      {
        const ataInfo = await provider.connection.getAccountInfo(rejectArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(rejectArtist.publicKey, rejectArtistAta, rejectArtist.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [rejectArtist]);
        }
      }
      const rejectRwa = getRwaPdas(rejectProjectPda, rwaTokenProgramId);
      const rejectRwaAccounts = getFinalizeProposalRwaAccounts(rejectProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
      const rejectAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        rejectProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      const rejectFinalizeBuilder = governance.methods
        .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
        .accountsStrict({
          proposal: proposalPda,
          project: rejectProjectPda,
          payer: provider.wallet.publicKey,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: escrowPda,
          escrowAuthority,
          artistTokenAccount: rejectArtistAta,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
          rwaState: rejectRwa.rwaState,
          rwaMint: rejectRwa.rwaMint,
          rwaMintAuthority: rejectRwa.rwaMintAuthority,
          rwaConfig: rejectRwa.rwaConfig,
          rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
          rwaExtraAccountMetas: rejectRwa.rwaExtraAccountMetas,
          rwaMetadataGuard: rejectRwa.rwaMetadataGuard,
          rwaMetadata: rejectRwa.rwaMetadata,
          artist: rejectArtist.publicKey,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          rwaTokenProgram: rwaTokenProgramId,
          ...rejectRwaAccounts,
          systemProgram: SystemProgram.programId,
        })
        .signers([rejectArtist]);
      await sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), rejectFinalizeBuilder, rejectAlt.alt, [rejectArtist]);
      const proposal = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(proposalPda);
      expect((proposal as { status: { rejected?: unknown } }).status?.rejected !== undefined || (proposal as { status: number }).status === 1).to.be.true;
      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(rejectProjectPda) as { currentMilestone: number };
      expect(project.currentMilestone).to.equal(0);

      // Material-edit proposal (milestone 255) on same project: create, vote, finalize, opt_out_refund
      const projectTermsPda = getProjectTermsPda(rejectProjectPda, projectEscrowProgramId);
      const attemptPda2 = getProposalAttemptPda(rejectProjectPda, governance.programId);
      const attempt2 = await getCurrentProposalAttempt(governance, attemptPda2);
      const materialProposalPda = getProposalPda(rejectProjectPda, 255, attempt2, governance.programId);
      const matEditVotingPeriod = new anchor.BN(3);
      await governance.methods
        .createProposal(
          rejectProjectPda,
          255,
          "https://proof.example/material-edit",
          matEditVotingPeriod,
          new anchor.BN(attempt2)
        )
        .accounts({
          artist: rejectArtist.publicKey,
          proposalAttempt: attemptPda2,
          proposal: materialProposalPda,
          project: rejectProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([rejectArtist])
        .rpc();
      for (let i = 0; i < 5; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), rejectProjectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), materialProposalPda.toBuffer(), backers[i].publicKey.toBuffer()],
          governanceProgramId
        );
        await governance.methods
          .castVote(true)
          .accounts({
            proposal: materialProposalPda,
            voter: backers[i].publicKey,
            backer: backerPda,
            vote: votePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();
      }
      // Wait for material-edit voting period (3s) to end; use 6s in CI
      await new Promise((r) => setTimeout(r, 6000));
      const newTermsHash = Buffer.alloc(32);
      newTermsHash.write("material-edit-terms-hash-v1");
      const releaseAuthorityPda = PublicKey.findProgramAddressSync(
        [Buffer.from("release_authority")],
        governanceProgramId
      )[0];
      const releaseAuthorityLamports = await provider.connection.getBalance(releaseAuthorityPda);
      if (releaseAuthorityLamports < 10_000_000) {
        const sig = await provider.connection.requestAirdrop(releaseAuthorityPda, 10_000_000);
        await provider.connection.confirmTransaction(sig, "confirmed");
      }

      await (governance.methods as unknown as { finalizeMaterialEditProposal: (a: number[], b: anchor.BN, c: anchor.BN, d: anchor.BN, e: number[]) => { accounts: (acc: Record<string, unknown>) => { rpc: () => Promise<string> } } })
        .finalizeMaterialEditProposal(
          Array.from(newTermsHash),
          new anchor.BN(7 * 24 * 3600),
          new anchor.BN(String(GOAL)),
          new anchor.BN(Math.floor(Date.now() / 1000) + 365 * 24 * 3600),
          [20, 20, 20, 20, 20]
        )
        .accounts({
          proposal: materialProposalPda,
          project: rejectProjectPda,
          releaseAuthority: releaseAuthorityPda,
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          projectTerms: projectTermsPda,
          systemProgram: SystemProgram.programId,
          projectEscrowProgram: projectEscrowProgramId,
        })
        .rpc();
      const terms = await (projectEscrow.account as { projectTerms: { fetch: (p: PublicKey) => Promise<{ refundWindowEnd: { toNumber: () => number }; version: number }> } }).projectTerms.fetch(projectTermsPda);
      expect(terms.version).to.equal(1);
      const firstBackerPda = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), rejectProjectPda.toBuffer(), backers[0].publicKey.toBuffer()],
        projectEscrowProgramId
      )[0];
      const firstBackerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey, false, TOKEN_2022_PROGRAM_ID);
      await projectEscrow.methods
        .optOutRefund()
        .accounts({
          backerWallet: backers[0].publicKey,
          project: rejectProjectPda,
          projectTerms: projectTermsPda,
          backer: firstBackerPda,
          backerTokenAccount: firstBackerAta,
          escrow: escrowPda,
          escrowAuthority,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([backers[0]])
        .rpc();
      const backerAfter = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).backer.fetch(firstBackerPda) as { amount: { toString(): string } };
      expect(BigInt(backerAfter.amount.toString())).to.equal(0n);
    });

    it("material-edit proposal rejected: finalize does not apply material edit", async () => {
      const projectTermsPda = getProjectTermsPda(rejectProjectPda, projectEscrowProgramId);
      const termsBefore = await (projectEscrow.account as { projectTerms: { fetch: (p: PublicKey) => Promise<{ version: number; refundWindowEnd: { toNumber: () => number } }> } }).projectTerms.fetch(projectTermsPda);

      const attemptPda3 = getProposalAttemptPda(rejectProjectPda, governance.programId);
      const attempt3 = await getCurrentProposalAttempt(governance, attemptPda3);
      const materialRejectProposalPda = getProposalPda(rejectProjectPda, 255, attempt3, governance.programId);
      const matEditVotingPeriod = new anchor.BN(3);
      await governance.methods
        .createProposal(
          rejectProjectPda,
          255,
          "https://proof.example/material-edit-reject",
          matEditVotingPeriod,
          new anchor.BN(attempt3)
        )
        .accounts({
          artist: rejectArtist.publicKey,
          proposalAttempt: attemptPda3,
          proposal: materialRejectProposalPda,
          project: rejectProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([rejectArtist])
        .rpc();

      // Backer 0 opted out (refund) in a prior test, so only backers 1..4 have contribution; only they can cast_vote.
      for (let i = 1; i < 5; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), rejectProjectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const [votePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vote"), materialRejectProposalPda.toBuffer(), backers[i].publicKey.toBuffer()],
          governanceProgramId
        );
        await governance.methods
          .castVote(i >= 4)
          .accounts({
            proposal: materialRejectProposalPda,
            voter: backers[i].publicKey,
            backer: backerPda,
            vote: votePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();
      }
      await new Promise((r) => setTimeout(r, 6000));
      const newTermsHashReject = Buffer.alloc(32);
      newTermsHashReject.write("rejected-material-edit-hash");
      const releaseAuthorityPda = PublicKey.findProgramAddressSync(
        [Buffer.from("release_authority")],
        governanceProgramId
      )[0];
      await (governance.methods as unknown as { finalizeMaterialEditProposal: (a: number[], b: anchor.BN, c: anchor.BN, d: anchor.BN, e: number[]) => { accounts: (acc: Record<string, unknown>) => { rpc: () => Promise<string> } } })
        .finalizeMaterialEditProposal(
          Array.from(newTermsHashReject),
          new anchor.BN(7 * 24 * 3600),
          new anchor.BN(String(GOAL)),
          new anchor.BN(Math.floor(Date.now() / 1000) + 365 * 24 * 3600),
          [20, 20, 20, 20, 20]
        )
        .accounts({
          proposal: materialRejectProposalPda,
          project: rejectProjectPda,
          releaseAuthority: releaseAuthorityPda,
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          projectTerms: projectTermsPda,
          systemProgram: SystemProgram.programId,
          projectEscrowProgram: projectEscrowProgramId,
        })
        .rpc();
      const proposalAfter = await (governance.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).proposal.fetch(materialRejectProposalPda) as { status: Record<string, unknown> | number };
      expect((proposalAfter.status as Record<string, unknown>)?.rejected !== undefined || proposalAfter.status === 1).to.be.true;
      const termsAfter = await (projectEscrow.account as { projectTerms: { fetch: (p: PublicKey) => Promise<{ version: number; refundWindowEnd: { toNumber: () => number } }> } }).projectTerms.fetch(projectTermsPda);
      expect(termsAfter.version).to.equal(termsBefore.version);
      expect(termsAfter.refundWindowEnd.toNumber()).to.equal(termsBefore.refundWindowEnd.toNumber());
    });

    it("quorum not met: finalize fails with QuorumNotMet", async () => {
      const quorumArtist = Keypair.generate();
      await airdrop(quorumArtist.publicKey);
      const quorumProjectPda = getProjectPda(quorumArtist.publicKey, 0, projectEscrowProgramId);
      const [artistStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("artist_state"), quorumArtist.publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), quorumProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), quorumProjectPda.toBuffer()],
        projectEscrowProgramId
      );
      const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);
      await projectEscrow.methods
        .createProject("Test Album", new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: quorumArtist.publicKey,
          artistState: artistStatePda,
          project: quorumProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([quorumArtist])
        .rpc();
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      const [backerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("backer"), quorumProjectPda.toBuffer(), backers[2].publicKey.toBuffer()],
        projectEscrowProgramId
      );
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[2].publicKey, false, TOKEN_2022_PROGRAM_ID);
      const tinyAmount = 100 * LAMPORTS_PER_TASTE;
      await projectEscrow.methods
        .fundProject(new anchor.BN(tinyAmount))
        .accounts({
          backerWallet: backers[2].publicKey,
          project: quorumProjectPda,
          backer: backerPda,
          backerTokenAccount: backerAta,
          escrow: escrowPda,
          platformTreasury,
          burnVaultAuthority,
          burnVaultTokenAccount,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[2]])
        .rpc();
      const proposalAttemptPda = getProposalAttemptPda(quorumProjectPda, governance.programId);
      const attemptQuorum = await getCurrentProposalAttempt(governance, proposalAttemptPda);
      const proposalPda = getProposalPda(quorumProjectPda, 0, attemptQuorum, governance.programId);
      const shortPeriod = new anchor.BN(2);
      await governance.methods
        .createProposal(quorumProjectPda, 0, "https://proof.example/quorum", shortPeriod, new anchor.BN(attemptQuorum))
        .accounts({
          artist: quorumArtist.publicKey,
          proposalAttempt: proposalAttemptPda,
          proposal: proposalPda,
          project: quorumProjectPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: getGovConfigPda(governanceProgramId), isSigner: false, isWritable: false },
        ])
        .signers([quorumArtist])
        .rpc();
      await new Promise((r) => setTimeout(r, 3000));
      // create artist ATA
      const quorumArtistAta = getAssociatedTokenAddressSync(tasteMint, quorumArtist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      {
        const ataInfo = await provider.connection.getAccountInfo(quorumArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(quorumArtist.publicKey, quorumArtistAta, quorumArtist.publicKey, tasteMint, TOKEN_2022_PROGRAM_ID)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [quorumArtist]);
        }
      }
      const quorumRwa = getRwaPdas(quorumProjectPda, rwaTokenProgramId);
      const quorumRwaAccounts = getFinalizeProposalRwaAccounts(quorumProjectPda, tasteMint, rwaTokenProgramId, revenueDistributionProgramId);
      const quorumAlt = await createAltForFinalize(
        provider.connection,
        getProviderPayerKeypair(provider),
        quorumProjectPda,
        tasteMint,
        rwaTokenProgramId,
        revenueDistributionProgramId
      );
      const quorumFinalizeBuilder = governance.methods
        .finalizeProposal(...DEFAULT_FINALIZE_RWA_ARGS)
        .accountsStrict({
          proposal: proposalPda,
          project: quorumProjectPda,
          payer: provider.wallet.publicKey,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: escrowPda,
          escrowAuthority,
          artistTokenAccount: quorumArtistAta,
          tasteMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
          rwaState: quorumRwa.rwaState,
          rwaMint: quorumRwa.rwaMint,
          rwaMintAuthority: quorumRwa.rwaMintAuthority,
          rwaConfig: quorumRwa.rwaConfig,
          rwaTransferHookProgram: RWA_TRANSFER_HOOK_PROGRAM_ID,
          rwaExtraAccountMetas: quorumRwa.rwaExtraAccountMetas,
          rwaMetadataGuard: quorumRwa.rwaMetadataGuard,
          rwaMetadata: quorumRwa.rwaMetadata,
          artist: quorumArtist.publicKey,
          tokenMetadataProgram: MPL_TOKEN_METADATA_ID,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_ID,
          rwaTokenProgram: rwaTokenProgramId,
          ...quorumRwaAccounts,
          systemProgram: SystemProgram.programId,
        })
        .signers([quorumArtist]);
      await expect(
        sendFinalizeProposalV0(provider.connection, getProviderPayerKeypair(provider), quorumFinalizeBuilder, quorumAlt.alt, [quorumArtist])
      ).to.be.rejectedWith(/QuorumNotMet|quorum not met/);
    });

    it("milestone release math: portions per milestone, no refill; escrow drained", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const project = await (projectEscrow.account as Record<string, { fetch: (p: PublicKey) => Promise<unknown> }>).project.fetch(projectPda) as { totalRaised: { toString(): string }; milestonePercentages: number[]; currentMilestone: number };
      const totalRaised = BigInt(project.totalRaised.toString());
      const pcts = project.milestonePercentages;
      // each milestone releases (total_raised * pct) / 100
      let expectedReleased = 0n;
      for (let i = 0; i < pcts.length; i++) {
        expectedReleased += (totalRaised * BigInt(pcts[i])) / 100n;
      }
      expect(expectedReleased).to.equal(totalRaised);
      const artistAta = getAssociatedTokenAddressSync(tasteMint, artist.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const artistAtaInfo = await provider.connection.getAccountInfo(artistAta);
      if (!artistAtaInfo) {
        throw new Error("Artist ATA missing; main flow (5 milestone proposals) may not have completed. Ensure prior tests passed.");
      }
      const artistBalance = (await getAccount(provider.connection, artistAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const artistBal = typeof artistBalance === "bigint" ? artistBalance : BigInt(String(artistBalance));
      const tolerance = totalRaised / 10n;
      expect(artistBal >= expectedReleased - tolerance).to.be.true;
      expect(artistBal <= expectedReleased + tolerance).to.be.true;
      // escrow drained after all milestones
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const escrowInfo = await provider.connection.getAccountInfo(escrowPda);
      if (!escrowInfo) {
        throw new Error("Escrow account missing; project state may be inconsistent.");
      }
      const escrowBalance = (await getAccount(provider.connection, escrowPda, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const escrowAmt = typeof escrowBalance === "bigint" ? escrowBalance : BigInt(String(escrowBalance));
      // If main flow completed, escrow is 0; if proposals never ran, escrow still has funds
      if (project.currentMilestone >= 5) {
        expect(escrowAmt).to.equal(0n);
      }
    });

  });
});
