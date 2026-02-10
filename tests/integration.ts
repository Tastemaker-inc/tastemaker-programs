/**
 * TasteMaker programs integration test.
 * Run with: anchor test
 * Requires: anchor build (generates IDL under target/idl/)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import path from "path";
chai.use(chaiAsPromised);

function idlPath(name: string): string {
  return path.join(process.cwd(), "target", "idl", `${name}.json`);
}

describe("tastemaker-programs integration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const tasteTokenIdl = require(idlPath("taste_token"));
  const projectEscrowIdl = require(idlPath("project_escrow"));
  const governanceIdl = require(idlPath("governance"));
  const rwaTokenIdl = require(idlPath("rwa_token"));
  const tasteTokenId = new PublicKey(tasteTokenIdl.address);
  const projectEscrowId = new PublicKey(projectEscrowIdl.address);
  const governanceId = new PublicKey(governanceIdl.address);
  const rwaTokenId = new PublicKey(rwaTokenIdl.address);

  let tasteTokenProgram: Program;
  let projectEscrowProgram: Program;
  let governanceProgram: Program;
  let rwaTokenProgram: Program;

  let tasteMint: PublicKey;
  let treasuryAuthority: PublicKey;
  let artist: Keypair;
  let backer1: Keypair;

  const DECIMALS = 9;
  const GOAL = 1_000_000 * Math.pow(10, DECIMALS);
  const MILESTONES = [20, 20, 20, 20, 20] as [number, number, number, number, number];
  const DEADLINE_OFFSET = 30 * 24 * 60 * 60;

  function getProjectPda(artist: PublicKey, projectIndex: number, programId: PublicKey): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(projectIndex));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("project"), artist.toBuffer(), buf],
      programId
    )[0];
  }
  function getArtistStatePda(artist: PublicKey, programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("artist_state"), artist.toBuffer()],
      programId
    )[0];
  }
  function getPlatformTreasuryAta(mint: PublicKey, tasteProgramId: PublicKey): PublicKey {
    const [treasuryAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      tasteProgramId
    );
    return getAssociatedTokenAddressSync(mint, treasuryAuth, true);
  }
  function getBurnVaultAccounts(mint: PublicKey, escrowProgramId: PublicKey): { authority: PublicKey; tokenAccount: PublicKey } {
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from("burn_vault")],
      escrowProgramId
    );
    return { authority, tokenAccount: getAssociatedTokenAddressSync(mint, authority) };
  }
  function getProposalAttemptPda(project: PublicKey, govProgramId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_attempt"), project.toBuffer()],
      govProgramId
    )[0];
  }
  function getProposalPda(project: PublicKey, milestone: number, attempt: number, govProgramId: PublicKey): PublicKey {
    const attemptBuf = Buffer.alloc(8);
    attemptBuf.writeBigUInt64LE(BigInt(attempt));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), project.toBuffer(), Buffer.from([milestone]), attemptBuf],
      govProgramId
    )[0];
  }

  before(async () => {
    artist = Keypair.generate();
    backer1 = Keypair.generate();

    const airdrop = async (pubkey: PublicKey) => {
      const sig = await provider.connection.requestAirdrop(pubkey, 2e9);
      await provider.connection.confirmTransaction(sig);
    };
    await airdrop(artist.publicKey);
    await airdrop(backer1.publicKey);

    tasteTokenProgram = new Program(tasteTokenIdl, tasteTokenId, provider);
    projectEscrowProgram = new Program(projectEscrowIdl, projectEscrowId, provider);
    governanceProgram = new Program(governanceIdl, governanceId, provider);
    rwaTokenProgram = new Program(rwaTokenIdl, rwaTokenId, provider);
  });

  it("initializes taste mint and treasury", async () => {
    const [mintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("taste_mint")],
      tasteTokenId
    );
    const [treasuryAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      tasteTokenId
    );
    const treasuryAta = getAssociatedTokenAddressSync(
      mintPda,
      treasuryAuthPda,
      true
    );

    await tasteTokenProgram.methods
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

  it("mints TASTE to treasury and to backer", async () => {
    const treasuryAta = getAssociatedTokenAddressSync(
      tasteMint,
      treasuryAuthority,
      true
    );
    const amount = new anchor.BN(10_000_000 * Math.pow(10, DECIMALS));
    await tasteTokenProgram.methods
      .mintToTreasury(amount)
      .accounts({
        mintAuthority: provider.wallet.publicKey,
        mint: tasteMint,
        treasury: treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const backerAta = getAssociatedTokenAddressSync(tasteMint, backer1.publicKey);
    const backerAccountInfo = await provider.connection.getAccountInfo(backerAta);
    if (!backerAccountInfo) {
      const createAtaIx = createAssociatedTokenAccountInstruction(
        provider.wallet.publicKey,
        backerAta,
        backer1.publicKey,
        tasteMint
      );
      await provider.sendAndConfirm(new Transaction().add(createAtaIx));
    }
    const backerAmount = new anchor.BN(500_000 * Math.pow(10, DECIMALS));
    await tasteTokenProgram.methods
      .mintTo(backerAmount)
      .accounts({
        mintAuthority: provider.wallet.publicKey,
        mint: tasteMint,
        recipient: backerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  });

  it("artist creates project", async () => {
    const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowId);
    const artistStatePda = getArtistStatePda(artist.publicKey, projectEscrowId);
    const [escrowAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("project"), projectPda.toBuffer()],
      projectEscrowId
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), projectPda.toBuffer()],
      projectEscrowId
    );
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + DEADLINE_OFFSET);

    await projectEscrowProgram.methods
      .createProject(
        new anchor.BN(GOAL),
        MILESTONES,
        deadline
      )
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

    const project = await projectEscrowProgram.account.project.fetch(projectPda);
    expect(project.artist.equals(artist.publicKey)).to.be.true;
    expect(project.goal.toNumber()).to.equal(GOAL);
  });

  it("backer funds project", async () => {
    const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowId);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), projectPda.toBuffer()],
      projectEscrowId
    );
    const [backer1Pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("backer"),
        projectPda.toBuffer(),
        backer1.publicKey.toBuffer(),
      ],
      projectEscrowId
    );
    const backerAta = getAssociatedTokenAddressSync(tasteMint, backer1.publicKey);
    const fundAmount = new anchor.BN(500_000 * Math.pow(10, DECIMALS));
    const platformTreasury = getPlatformTreasuryAta(tasteMint, tasteTokenId);
    const { authority: burnVaultAuthority, tokenAccount: burnVaultTokenAccount } = getBurnVaultAccounts(tasteMint, projectEscrowId);

    await projectEscrowProgram.methods
      .fundProject(fundAmount)
      .accounts({
        backerWallet: backer1.publicKey,
        project: projectPda,
        backer: backer1Pda,
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
      .signers([backer1])
      .rpc();

    const project = await projectEscrowProgram.account.project.fetch(projectPda);
    const expectedEscrow = (500_000 * Math.pow(10, DECIMALS)) * 96 / 100;
    expect(project.totalRaised.toNumber()).to.equal(expectedEscrow);
  });

  it("artist creates proposal for milestone 0", async () => {
    const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowId);
    const proposalAttemptPda = getProposalAttemptPda(projectPda, governanceId);
    const proposalPda = getProposalPda(projectPda, 0, 0, governanceId);
    const votingPeriodSecs = new anchor.BN(24 * 3600);

    await governanceProgram.methods
      .createProposal(
        projectPda,
        0,
        "https://proof.example/m0",
        votingPeriodSecs,
        new anchor.BN(0)
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

    const proposal = await governanceProgram.account.proposal.fetch(proposalPda);
    expect(proposal.milestoneIndex).to.equal(0);
  });

  it("backer casts vote", async () => {
    const projectPda = getProjectPda(artist.publicKey, 0, projectEscrowId);
    const proposalPda = getProposalPda(projectPda, 0, 0, governanceId);
    const [backer1Pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("backer"),
        projectPda.toBuffer(),
        backer1.publicKey.toBuffer(),
      ],
      projectEscrowId
    );
    const [votePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote"),
        proposalPda.toBuffer(),
        backer1.publicKey.toBuffer(),
      ],
      governanceId
    );

    await governanceProgram.methods
      .castVote(true)
      .accounts({
        proposal: proposalPda,
        voter: backer1.publicKey,
        backer: backer1Pda,
        vote: votePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([backer1])
      .rpc();

    const proposal = await governanceProgram.account.proposal.fetch(proposalPda);
    expect(proposal.votesFor.toNumber()).to.be.greaterThan(0);
  });
});
