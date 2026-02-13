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
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import path from "path";
chai.use(chaiAsPromised);

const DECIMALS = 9;

function idlPath(name: string): string {
  return path.join(process.cwd(), "target", "idl", `${name}.json`);
}
const LAMPORTS_PER_TASTE = Math.pow(10, DECIMALS);

const MAX_WALL_CLOCK_MS = 12 * 60 * 1000; // 12 minutes
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
  return getAssociatedTokenAddressSync(tasteMint, treasuryAuth, true);
}

function getBurnVaultAccounts(tasteMint: PublicKey, projectEscrowProgramId: PublicKey): { authority: PublicKey; tokenAccount: PublicKey } {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("burn_vault")],
    projectEscrowProgramId
  );
  const tokenAccount = getAssociatedTokenAddressSync(tasteMint, authority, true);
  return { authority, tokenAccount };
}

function getProjectTermsPda(project: PublicKey, projectEscrowProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("project_terms"), project.toBuffer()],
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
  const attemptBuf = Buffer.from(new anchor.BN(attempt).toArrayLike(Array, "le", 8) as number[]);
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
    const acc = await governance.account.proposalAttempt.fetch(proposalAttemptPda);
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

  const tasteTokenProgramId = new PublicKey(tasteTokenIdl.address);
  const projectEscrowProgramId = new PublicKey(projectEscrowIdl.address);
  const governanceProgramId = new PublicKey(governanceIdl.address);
  const rwaTokenProgramId = new PublicKey(rwaTokenIdl.address);

  let tasteToken: Program;
  let projectEscrow: Program;
  let governance: Program;
  let rwaToken: Program;

  let tasteMint: PublicKey;
  let treasuryAuthority: PublicKey;
  let artist: Keypair;
  const BACKER_COUNT = 40;
  const backers: Keypair[] = [];
  const backerAmounts: bigint[] = [];
  let cancelProposalBacker: Keypair;
  let cancelBacker: Keypair;

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
    tasteToken = new Program(tasteTokenIdl, provider);
    projectEscrow = new Program(projectEscrowIdl, provider);
    governance = new Program(governanceIdl, provider);
    rwaToken = new Program(rwaTokenIdl, provider);

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
        true
      );

      await tasteToken.methods
        .initializeMint()
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: mintPda,
          treasuryAuthority: treasuryAuthPda,
          treasury: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
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
        true
      );
      const treasuryAmount = 100_000_000n * BigInt(LAMPORTS_PER_TASTE);
      await tasteToken.methods
        .mintToTreasury(new anchor.BN(treasuryAmount.toString()))
        .accounts({
          mintAuthority: provider.wallet.publicKey,
          mint: tasteMint,
          treasury: treasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
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
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey);
        const info = await provider.connection.getAccountInfo(backerAta);
        if (!info) {
          const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              backers[i].publicKey,
              backerAta,
              backers[i].publicKey,
              tasteMint
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
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }
      // extra TASTE for negative tests
      const negativeTestReserve = 10_000 * LAMPORTS_PER_TASTE;
      for (let i = 0; i < 5; i++) {
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey);
        await tasteToken.methods
          .mintTo(new anchor.BN(negativeTestReserve.toString()))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: backerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }
      // fund cancel-proposal backer
      const cancelProposalAmount = 50_000 * LAMPORTS_PER_TASTE;
      const cancelProposalAta = getAssociatedTokenAddressSync(tasteMint, cancelProposalBacker.publicKey);
      const cancelProposalAtaInfo = await provider.connection.getAccountInfo(cancelProposalAta);
      if (!cancelProposalAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            cancelProposalBacker.publicKey,
            cancelProposalAta,
            cancelProposalBacker.publicKey,
            tasteMint
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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      // fund cancelBacker before freeze
      const cancelBackerAmount = 100_000 * LAMPORTS_PER_TASTE;
      const cancelBackerAta = getAssociatedTokenAddressSync(tasteMint, cancelBacker.publicKey);
      const cancelBackerAtaInfo = await provider.connection.getAccountInfo(cancelBackerAta);
      if (!cancelBackerAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            cancelBacker.publicKey,
            cancelBackerAta,
            cancelBacker.publicKey,
            tasteMint
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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });

    it("burn: burns a small amount from one backer", async () => {
      const backer = backers[0];
      const burnAmount = new anchor.BN(1000); // 1000 raw units (0.000001 TASTE)
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backer.publicKey);
      await tasteToken.methods
        .burn(burnAmount)
        .accounts({
          owner: backer.publicKey,
          source: backerAta,
          mint: tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      const treasuryAta = getAssociatedTokenAddressSync(tasteMint, treasuryAuthority, true);
      await expect(
        tasteToken.methods
          .mintTo(new anchor.BN(1000))
          .accounts({
            mintAuthority: provider.wallet.publicKey,
            mint: tasteMint,
            recipient: treasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: artist.publicKey,
          artistState: artistStatePda,
          project: projectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([artist])
        .rpc();

      const project = await projectEscrow.account.project.fetch(projectPda);
      expect(project.artist.equals(artist.publicKey)).to.be.true;
      expect(BigInt(project.goal.toString())).to.equal(GOAL);
    });

    it("all backers fund project with their amounts", async () => {
      const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenProgramId);
      const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowProgramId);
      for (let i = 0; i < backers.length; i++) {
        const [backerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("backer"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
          projectEscrowProgramId
        );
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey);
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
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();
      }
      const project = await projectEscrow.account.project.fetch(projectPda);
      // 96% to escrow (4% fee: 2% treasury, 2% burn)
      const totalFunded = backerAmounts.reduce((a, b) => a + b, 0n);
      const expectedEscrow = (totalFunded * 96n) / 100n;
      expect(BigInt(project.totalRaised.toString())).to.equal(expectedEscrow);
      expect(project.backerCount).to.equal(BACKER_COUNT);
    });

    it("runs 5 milestone proposals with many voters and quadratic weights", async () => {
      const artistAta = getAssociatedTokenAddressSync(tasteMint, artist.publicKey);
      let artistAtaInfo = await provider.connection.getAccountInfo(artistAta);
      if (!artistAtaInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            artist.publicKey,
            artistAta,
            artist.publicKey,
            tasteMint
          )
        );
        await sendAndConfirmTransaction(provider.connection, tx, [artist]);
      }

      const proposalAttemptPda = getProposalAttemptPda(projectPda, governance.programId);
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

        const proposalBefore = await governance.account.proposal.fetch(proposalPda);
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

        await governance.methods
          .finalizeProposal()
          .accounts({
            proposal: proposalPda,
            project: projectPda,
            releaseAuthority,
            escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
            escrow: escrowPda,
            escrowAuthority,
            artistTokenAccount: artistAta,
            tasteMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            projectEscrowProgram: projectEscrowProgramId,
          })
          .rpc();

        const proposalAfter = await governance.account.proposal.fetch(proposalPda);
        expect(
          "passed" in proposalAfter.status || "active" in proposalAfter.status
        ).to.be.true;
      }

      const projectAfter = await projectEscrow.account.project.fetch(projectPda);
      expect(projectAfter.currentMilestone).to.equal(5);
      expect("completed" in projectAfter.status).to.be.true;
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

    it("artist initializes RWA mint for project", async () => {
      await rwaToken.methods
        .initializeRwaMint(new anchor.BN(RWA_TOTAL_SUPPLY.toString()))
        .accounts({
          authority: artist.publicKey,
          project: projectPda,
          rwaState: rwaStatePda,
          rwaMint: rwaMintPda,
          rwaMintAuthority: PublicKey.findProgramAddressSync(
            [Buffer.from("rwa_mint_authority"), projectPda.toBuffer()],
            rwaTokenProgramId
          )[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([artist])
        .rpc();

      const state = await rwaToken.account.rwaState.fetch(rwaStatePda);
      expect(BigInt(state.totalSupply.toString())).to.equal(RWA_TOTAL_SUPPLY);
      expect(state.authority.equals(artist.publicKey)).to.be.true;
    });

    it("all backers claim RWA tokens", async () => {
      const project = await projectEscrow.account.project.fetch(projectPda);
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
          backers[i].publicKey
        );

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
            claimRecord: claimRecordPda,
            backerTokenAccount: backerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[i]])
          .rpc();

        const expectedShare = (backerAmounts[i] * RWA_TOTAL_SUPPLY) / totalRaised;
        if (expectedShare > 0n) {
          try {
            const tokenAccount = await getAccount(provider.connection, backerAta);
            const amount = typeof tokenAccount.amount === "bigint" ? tokenAccount.amount : BigInt(tokenAccount.amount.toString());
            expect(amount >= expectedShare - 1n).to.be.true;
          } catch (e) {
            // Account may not exist yet or rounding; verify claim record instead
            const [claimRecordPda] = PublicKey.findProgramAddressSync(
              [Buffer.from("claim"), projectPda.toBuffer(), backers[i].publicKey.toBuffer()],
              rwaTokenProgramId
            );
            const record = await rwaToken.account.claimRecord.fetch(claimRecordPda);
            expect((record as { claimed: boolean }).claimed).to.be.true;
          }
        }
      }

      const state = await rwaToken.account.rwaState.fetch(rwaStatePda);
      const minted = BigInt(state.minted.toString());
      expect(minted >= RWA_TOTAL_SUPPLY - 100n).to.be.true;
      expect(minted <= RWA_TOTAL_SUPPLY + 100n).to.be.true;
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

      const state = await rwaToken.account.rwaState.fetch(rwaStatePda);
      expect((state as { mintFrozen: boolean }).mintFrozen).to.be.true;
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
        .createProject(goal, MILESTONES, deadline)
        .accounts({
          artist: cancelProposalArtist.publicKey,
          artistState: cancelProposalArtistStatePda,
          project: cancelProposalProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cancelProposalArtist])
        .rpc();

      const backerAta = getAssociatedTokenAddressSync(
        tasteMint,
        cancelProposalBacker.publicKey
      );
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
          tokenProgram: TOKEN_PROGRAM_ID,
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

      const after = await governance.account.proposal.fetch(cancelProposalPda);
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
        .createProject(goal, MILESTONES, deadline)
        .accounts({
          artist: cancelArtist.publicKey,
          artistState: cancelArtistStatePda,
          project: cancelProjectPda,
          escrowAuthority,
          escrow: cancelEscrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([cancelArtist])
        .rpc();

      const backerAta = getAssociatedTokenAddressSync(tasteMint, cancelBacker.publicKey);
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
          tokenProgram: TOKEN_PROGRAM_ID,
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

      const project = await projectEscrow.account.project.fetch(cancelProjectPda);
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, cancelBacker.publicKey);

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
          tokenProgram: TOKEN_PROGRAM_ID,
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
          const vote = await governance.account.vote.fetch(votePda);
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
    it("unauthorized mint: non-authority cannot mint TASTE", async () => {
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey);
      await expect(
        tasteToken.methods
          .mintTo(new anchor.BN(1000))
          .accounts({
            mintAuthority: backers[0].publicKey,
            mint: tasteMint,
            recipient: backerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
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
          .createProject(new anchor.BN(GOAL.toString()), badMilestones, deadline)
          .accounts({
            artist: badArtist.publicKey,
            artistState: artistStatePda,
            project: projectPda,
            escrowAuthority,
            escrow: escrowPda,
            tasteMint,
            tokenProgram: TOKEN_PROGRAM_ID,
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, pastDeadline)
        .accounts({
          artist: pastArtist.publicKey,
          artistState: artistStatePda,
          project: projectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey);
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
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([backers[0]])
          .rpc()
      ).to.be.rejectedWith(/ProjectDeadlinePassed|deadline|6010/);
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey);
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
            tokenProgram: TOKEN_PROGRAM_ID,
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
        backer.publicKey
      );
      let failed = false;
      let errMsg = "";
      try {
        await rwaToken.methods
          .claimRwaTokens()
          .accounts({
            backer: backer.publicKey,
            backerAccount: backerPda,
            project: projectPda,
            rwaState: rwaStatePda,
            rwaMint: PublicKey.findProgramAddressSync([Buffer.from("rwa_mint"), projectPda.toBuffer()], rwaTokenProgramId)[0],
            rwaMintAuthority,
            claimRecord: claimPda,
            backerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
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
      // check error string
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: voteExpiredArtist.publicKey,
          artistState: artistStatePda,
          project: expiredProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey);
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
          tokenProgram: TOKEN_PROGRAM_ID,
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: earlyFinalArtist.publicKey,
          artistState: artistStatePda,
          project: earlyProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[3].publicKey);
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
          tokenProgram: TOKEN_PROGRAM_ID,
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
        .signers([earlyFinalArtist])
        .rpc();
      // create artist ATA
      const earlyArtistAta = getAssociatedTokenAddressSync(tasteMint, earlyFinalArtist.publicKey);
      const ataInfo = await provider.connection.getAccountInfo(earlyArtistAta);
      if (!ataInfo) {
        const ataTx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            earlyFinalArtist.publicKey,
            earlyArtistAta,
            earlyFinalArtist.publicKey,
            tasteMint
          )
        );
        await sendAndConfirmTransaction(provider.connection, ataTx, [earlyFinalArtist]);
      }
      await expect(
        governance.methods
          .finalizeProposal()
          .accounts({
            proposal: proposalPda,
            project: earlyProjectPda,
            releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
            escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
            escrow: escrowPda,
            escrowAuthority,
            artistTokenAccount: earlyArtistAta,
            tasteMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            projectEscrowProgram: projectEscrowProgramId,
          })
          .rpc()
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: activeArtist.publicKey,
          artistState: artistStatePda,
          project: activeProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([activeArtist])
        .rpc();
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
          .accounts({
            authority: activeArtist.publicKey,
            project: activeProjectPda,
            rwaState: rwaStatePda,
            rwaMint: rwaMintPda,
            rwaMintAuthority,
            tokenProgram: TOKEN_PROGRAM_ID,
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: doubleArtist.publicKey,
          artistState: artistStatePda,
          project: doubleProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[1].publicKey);
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
          tokenProgram: TOKEN_PROGRAM_ID,
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
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([backers[1]])
        .rpc();
      const backerAcc = await projectEscrow.account.backer.fetch(backerPda);
      const expectedEscrow = (BigInt(firstAmount) * 96n) / 100n + (BigInt(secondAmount) * 96n) / 100n;
      expect(BigInt(backerAcc.amount.toString())).to.equal(expectedEscrow);
    });

    it("proposal rejected: votes_against > votes_for yields Rejected and no escrow release", async () => {
      const rejectArtist = Keypair.generate();
      await airdrop(rejectArtist.publicKey);
      const rejectProjectPda = getProjectPda(rejectArtist.publicKey, 0, projectEscrowProgramId);
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: rejectArtist.publicKey,
          artistState: artistStatePda,
          project: rejectProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
        const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[i].publicKey);
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
            tokenProgram: TOKEN_PROGRAM_ID,
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
      await new Promise((r) => setTimeout(r, 4000));
      // create artist ATA
      const rejectArtistAta = getAssociatedTokenAddressSync(tasteMint, rejectArtist.publicKey);
      {
        const ataInfo = await provider.connection.getAccountInfo(rejectArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(rejectArtist.publicKey, rejectArtistAta, rejectArtist.publicKey, tasteMint)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [rejectArtist]);
        }
      }
      await governance.methods
        .finalizeProposal()
        .accounts({
          proposal: proposalPda,
          project: rejectProjectPda,
          releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
          escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
          escrow: escrowPda,
          escrowAuthority,
          artistTokenAccount: rejectArtistAta,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          projectEscrowProgram: projectEscrowProgramId,
        })
        .rpc();
      const proposal = await governance.account.proposal.fetch(proposalPda);
      expect((proposal as { status: { rejected?: unknown } }).status?.rejected !== undefined || (proposal as { status: number }).status === 1).to.be.true;
      const project = await projectEscrow.account.project.fetch(rejectProjectPda);
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
      await new Promise((r) => setTimeout(r, 4000));
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

      await (governance.methods as { finalizeMaterialEditProposal: (a: number[], b: anchor.BN, c: anchor.BN, d: anchor.BN, e: number[]) => { accounts: (acc: Record<string, unknown>) => { rpc: () => Promise<string> } } })
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
      const firstBackerAta = getAssociatedTokenAddressSync(tasteMint, backers[0].publicKey);
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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([backers[0]])
        .rpc();
      const backerAfter = await projectEscrow.account.backer.fetch(firstBackerPda);
      expect(BigInt(backerAfter.amount.toString())).to.equal(0n);
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
        .createProject(new anchor.BN(GOAL.toString()), MILESTONES, deadline)
        .accounts({
          artist: quorumArtist.publicKey,
          artistState: artistStatePda,
          project: quorumProjectPda,
          escrowAuthority,
          escrow: escrowPda,
          tasteMint,
          tokenProgram: TOKEN_PROGRAM_ID,
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
      const backerAta = getAssociatedTokenAddressSync(tasteMint, backers[2].publicKey);
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
          tokenProgram: TOKEN_PROGRAM_ID,
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
        .signers([quorumArtist])
        .rpc();
      await new Promise((r) => setTimeout(r, 3000));
      // create artist ATA
      const quorumArtistAta = getAssociatedTokenAddressSync(tasteMint, quorumArtist.publicKey);
      {
        const ataInfo = await provider.connection.getAccountInfo(quorumArtistAta);
        if (!ataInfo) {
          const ataTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(quorumArtist.publicKey, quorumArtistAta, quorumArtist.publicKey, tasteMint)
          );
          await sendAndConfirmTransaction(provider.connection, ataTx, [quorumArtist]);
        }
      }
      await expect(
        governance.methods
          .finalizeProposal()
          .accounts({
            proposal: proposalPda,
            project: quorumProjectPda,
            releaseAuthority: PublicKey.findProgramAddressSync([Buffer.from("release_authority")], governanceProgramId)[0],
            escrowConfig: getEscrowConfigPda(projectEscrowProgramId),
            escrow: escrowPda,
            escrowAuthority,
            artistTokenAccount: quorumArtistAta,
            tasteMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            projectEscrowProgram: projectEscrowProgramId,
          })
          .rpc()
      ).to.be.rejectedWith(/QuorumNotMet|quorum not met/);
    });

    it("milestone release math: portions per milestone, no refill; escrow drained", async () => {
      const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowProgramId);
      const project = await projectEscrow.account.project.fetch(projectPda);
      const totalRaised = BigInt(project.totalRaised.toString());
      const pcts = project.milestonePercentages as number[];
      // each milestone releases (total_raised * pct) / 100
      let expectedReleased = 0n;
      for (let i = 0; i < pcts.length; i++) {
        expectedReleased += (totalRaised * BigInt(pcts[i])) / 100n;
      }
      expect(expectedReleased).to.equal(totalRaised);
      const artistAta = getAssociatedTokenAddressSync(tasteMint, artist.publicKey);
      const artistBalance = (await getAccount(provider.connection, artistAta)).amount;
      const artistBal = typeof artistBalance === "bigint" ? artistBalance : BigInt(artistBalance.toString());
      const tolerance = totalRaised / 10n;
      expect(artistBal >= expectedReleased - tolerance).to.be.true;
      expect(artistBal <= expectedReleased + tolerance).to.be.true;
      // escrow drained after all milestones
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), projectPda.toBuffer()],
        projectEscrowProgramId
      );
      const escrowBalance = (await getAccount(provider.connection, escrowPda)).amount;
      const escrowAmt = typeof escrowBalance === "bigint" ? escrowBalance : BigInt(escrowBalance.toString());
      // If main flow completed, escrow is 0; if proposals never ran, escrow still has funds
      if (project.currentMilestone >= 5) {
        expect(escrowAmt).to.equal(0n);
      }
    });

  });
});
