/**
 * OTC market program tests: create_offer, cancel_offer, accept_offer invariants and failures.
 * Run after exhaustive (same validator) or with: anchor test (add this to test script).
 * Covers: NotToken2022, InvalidAmount, InvalidPrice, NotMaker, TakerIsMaker, OfferExpired, OfferNotOpen (double-fill).
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
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createMint,
  TOKEN_2022_PROGRAM_ID,
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

const TOKEN_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

describe("otc_market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let otcProgram: Program;
  let otcProgramId: PublicKey;
  let quoteMint: PublicKey;
  let maker: Keypair;
  let taker: Keypair;
  let assetMint: PublicKey;
  let expiredOfferNonce: number | null = null;
  const decimals = 9;
  const amount = new anchor.BN(1_000_000);
  const price = new anchor.BN(2_000_000);

  function makerStatePda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    )[0];
  }

  function offerPda(nonce: number): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(nonce));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), maker.publicKey.toBuffer(), buf],
      otcProgramId
    )[0];
  }

  function escrowAuthorityPda(nonce: number): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(nonce));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), buf],
      otcProgramId
    )[0];
  }

  before(async () => {
    maker = Keypair.generate();
    taker = Keypair.generate();

    const airdrop = async (pubkey: PublicKey) => {
      const sig = await provider.connection.requestAirdrop(pubkey, 2e9);
      await provider.connection.confirmTransaction(sig);
    };
    await airdrop(maker.publicKey);
    await airdrop(taker.publicKey);

    const otcIdl = require(idlPath("otc_market"));
    otcProgram = new Program(otcIdl, provider);
    otcProgramId = otcProgram.programId;

    assetMint = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      decimals,
      undefined,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    quoteMint = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      decimals,
      undefined,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("initialize: succeeds when called by payer (no-op)", async () => {
    await otcProgram.methods
      .initialize()
      .accounts({
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("create_offer rejects non-Token-2022 asset (wrong token program)", async () => {
    const [makerState] = PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    );
    const nonce = 0;
    const offer = offerPda(nonce);
    const escrowAuthority = escrowAuthorityPda(nonce);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    const expirySlot = new anchor.BN((await provider.connection.getSlot()) + 10000);

    await expect(
      otcProgram.methods
        .createOffer(amount, price, { sell: {} }, expirySlot)
        .accounts({
          maker: maker.publicKey,
          makerState,
          offer,
          assetMint,
          makerAssetAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          quoteMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc()
    ).to.be.rejected;
  });

  it("create_offer rejects zero amount", async () => {
    const [makerState] = PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    );
    const nonce = 0;
    const offer = offerPda(nonce);
    const escrowAuthority = escrowAuthorityPda(nonce);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    const expirySlot = new anchor.BN((await provider.connection.getSlot()) + 10000);

    await expect(
      otcProgram.methods
        .createOffer(new anchor.BN(0), price, { sell: {} }, expirySlot)
        .accounts({
          maker: maker.publicKey,
          makerState,
          offer,
          assetMint,
          makerAssetAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          quoteMint,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc()
    ).to.be.rejected;
  });

  it("create_offer rejects zero price", async () => {
    const [makerState] = PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    );
    const nonce = 0;
    const offer = offerPda(nonce);
    const escrowAuthority = escrowAuthorityPda(nonce);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    const expirySlot = new anchor.BN((await provider.connection.getSlot()) + 10000);

    await expect(
      otcProgram.methods
        .createOffer(amount, new anchor.BN(0), { sell: {} }, expirySlot)
        .accounts({
          maker: maker.publicKey,
          makerState,
          offer,
          assetMint,
          makerAssetAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          quoteMint,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc()
    ).to.be.rejected;
  });

  it("create_offer succeeds with Token-2022 asset", async () => {
    const makerAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const ataInfo = await provider.connection.getAccountInfo(makerAta);
    if (!ataInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        maker.publicKey,
        makerAta,
        maker.publicKey,
        assetMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(ix),
        [maker]
      );
    }
    const mintIx = createMintToInstruction(
      assetMint,
      makerAta,
      maker.publicKey,
      10_000_000 * Math.pow(10, decimals),
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(mintIx),
      [maker]
    );

    const [makerState] = PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    );
    const nonce = 0;
    const offer = offerPda(nonce);
    const escrowAuthority = escrowAuthorityPda(nonce);
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    const createEscrowAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      maker.publicKey,
      escrowAta,
      escrowAuthority,
      assetMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const makerQuoteInfo = await provider.connection.getAccountInfo(makerQuoteAta);
    if (!makerQuoteInfo) {
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            maker.publicKey,
            makerQuoteAta,
            maker.publicKey,
            quoteMint,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        ),
        [maker]
      );
    }
    const expirySlot = new anchor.BN((await provider.connection.getSlot()) + 100000);

    const tx = new Transaction().add(createEscrowAtaIx);
    tx.add(
      await otcProgram.methods
        .createOffer(amount, price, { sell: {} }, expirySlot)
        .accounts({
          maker: maker.publicKey,
          makerState,
          offer,
          assetMint,
          makerAssetAta: makerAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          quoteMint,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
    await sendAndConfirmTransaction(provider.connection, tx, [maker]);

    const offerAcc = await otcProgram.account.offer.fetch(offer);
    expect(offerAcc.status.open !== undefined).to.be.true;
    expect(offerAcc.maker.equals(maker.publicKey)).to.be.true;
  });

  it("cancel_offer by non-maker fails (NotMaker)", async () => {
    const offer = offerPda(0);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAuthority = escrowAuthorityPda(0);
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    await expect(
      otcProgram.methods
        .cancelOffer()
        .accounts({
          maker: taker.publicKey,
          offer,
          assetMint,
          quoteMint,
          makerAssetAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([taker])
        .rpc()
    ).to.be.rejected;
  });

  it("cancel_offer by maker succeeds", async () => {
    const offer = offerPda(0);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAuthority = escrowAuthorityPda(0);
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    await otcProgram.methods
      .cancelOffer()
      .accounts({
        maker: maker.publicKey,
        offer,
        assetMint,
        quoteMint,
        makerAssetAta,
        makerQuoteAta,
        escrowAuthority,
        escrowAta,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const offerAcc = await otcProgram.account.offer.fetch(offer);
    expect(offerAcc.status.cancelled !== undefined).to.be.true;
  });

  it("accept_offer on cancelled offer fails (OfferNotOpen)", async () => {
    const offer = offerPda(0);
    const makerAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const takerAta = getAssociatedTokenAddressSync(
      assetMint,
      taker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const takerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      taker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAuthority = escrowAuthorityPda(0);
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );

    await expect(
      otcProgram.methods
        .acceptOffer()
        .accounts({
          taker: taker.publicKey,
          offer,
          assetMint,
          quoteMint,
          makerAssetAta: makerAta,
          takerAssetAta: takerAta,
          makerQuoteAta,
          takerQuoteAta,
          escrowAuthority,
          escrowAta,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([taker])
        .rpc()
    ).to.be.rejected;
  });

  it("create second offer for accept tests", async () => {
    const [makerState] = PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    );
    const state = await otcProgram.account.makerState.fetch(makerState);
    const nonce = state.nonce.toNumber();
    const offer = offerPda(nonce);
    const escrowAuthority = escrowAuthorityPda(nonce);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    const createEscrowAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      maker.publicKey,
      escrowAta,
      escrowAuthority,
      assetMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const expirySlot = new anchor.BN((await provider.connection.getSlot()) + 100000);

    const tx = new Transaction().add(createEscrowAtaIx);
    tx.add(
      await otcProgram.methods
        .createOffer(amount, price, { sell: {} }, expirySlot)
        .accounts({
          maker: maker.publicKey,
          makerState,
          offer,
          assetMint,
          makerAssetAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          quoteMint,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
    await sendAndConfirmTransaction(provider.connection, tx, [maker]);
  });

  it("accept_offer with taker === maker fails (TakerIsMaker)", async () => {
    const offer = offerPda(1);
    const makerAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAuthority = escrowAuthorityPda(1);
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );

    await expect(
      otcProgram.methods
        .acceptOffer()
        .accounts({
          taker: maker.publicKey,
          offer,
          assetMint,
          quoteMint,
          makerAssetAta: makerAta,
          takerAssetAta: makerAta,
          makerQuoteAta,
          takerQuoteAta: makerQuoteAta,
          escrowAuthority,
          escrowAta,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([maker])
        .rpc()
    ).to.be.rejected;
  });

  it("create third offer with past expiry for OfferExpired test", async () => {
    const [makerState] = PublicKey.findProgramAddressSync(
      [Buffer.from("maker"), maker.publicKey.toBuffer()],
      otcProgramId
    );
    const state = await otcProgram.account.makerState.fetch(makerState);
    const nonce = state.nonce.toNumber();
    expiredOfferNonce = nonce;
    const offer = offerPda(nonce);
    const escrowAuthority = escrowAuthorityPda(nonce);
    const makerAssetAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );
    const createEscrowAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      maker.publicKey,
      escrowAta,
      escrowAuthority,
      assetMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const currentSlot = await provider.connection.getSlot();
    const pastExpirySlot = new anchor.BN(Math.max(0, currentSlot - 1));

    const tx = new Transaction().add(createEscrowAtaIx);
    tx.add(
      await otcProgram.methods
        .createOffer(amount, price, { sell: {} }, pastExpirySlot)
        .accounts({
          maker: maker.publicKey,
          makerState,
          offer,
          assetMint,
          makerAssetAta,
          makerQuoteAta,
          escrowAuthority,
          escrowAta,
          quoteMint,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );
    await sendAndConfirmTransaction(provider.connection, tx, [maker]);
  });

  it("accept_offer on expired offer fails (OfferExpired)", async () => {
    expect(expiredOfferNonce).to.not.equal(null);
    const offer = offerPda(expiredOfferNonce as number);
    const makerAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const takerAta = getAssociatedTokenAddressSync(
      assetMint,
      taker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const takerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      taker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const escrowAuthority = escrowAuthorityPda(expiredOfferNonce as number);
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );

    await expect(
      otcProgram.methods
        .acceptOffer()
        .accounts({
          taker: taker.publicKey,
          offer,
          assetMint,
          quoteMint,
          makerAssetAta: makerAta,
          takerAssetAta: takerAta,
          makerQuoteAta,
          takerQuoteAta,
          escrowAuthority,
          escrowAta,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([taker])
        .rpc()
    ).to.be.rejected;
  });

  it("accept_offer succeeds (sell) then second accept fails (OfferNotOpen)", async () => {
    const offer = offerPda(1);
    const makerAta = getAssociatedTokenAddressSync(
      assetMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const takerAta = getAssociatedTokenAddressSync(
      assetMint,
      taker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const makerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      maker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const takerQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      taker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const takerAssetInfo = await provider.connection.getAccountInfo(takerAta);
    if (!takerAssetInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        taker.publicKey,
        takerAta,
        taker.publicKey,
        assetMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(ix),
        [taker]
      );
    }
    const takerQuoteInfo = await provider.connection.getAccountInfo(takerQuoteAta);
    if (!takerQuoteInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        taker.publicKey,
        takerQuoteAta,
        taker.publicKey,
        quoteMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(ix),
        [taker]
      );
    }
    const makerQuoteInfo = await provider.connection.getAccountInfo(makerQuoteAta);
    if (!makerQuoteInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        maker.publicKey,
        makerQuoteAta,
        maker.publicKey,
        quoteMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(ix),
        [maker]
      );
    }
    const mintTakerQuoteIx = createMintToInstruction(
      quoteMint,
      takerQuoteAta,
      maker.publicKey,
      price.toNumber() * 2,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(mintTakerQuoteIx),
      [maker]
    );

    const escrowAuthority = escrowAuthorityPda(1);
    const escrowAta = getAssociatedTokenAddressSync(
      assetMint,
      escrowAuthority,
      true, // allowOwnerOffCurve: escrow authority is a PDA
      TOKEN_2022_PROGRAM_ID
    );

    await otcProgram.methods
      .acceptOffer()
      .accounts({
        taker: taker.publicKey,
        offer,
        assetMint,
        quoteMint,
        makerAssetAta: makerAta,
        takerAssetAta: takerAta,
        makerQuoteAta,
        takerQuoteAta,
        escrowAuthority,
        escrowAta,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();

    const offerAcc = await otcProgram.account.offer.fetch(offer);
    expect(offerAcc.status.taken !== undefined).to.be.true;

    await expect(
      otcProgram.methods
        .acceptOffer()
        .accounts({
          taker: taker.publicKey,
          offer,
          assetMint,
          quoteMint,
          makerAssetAta: makerAta,
          takerAssetAta: takerAta,
          makerQuoteAta,
          takerQuoteAta,
          escrowAuthority,
          escrowAta,
          assetTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([taker])
        .rpc()
    ).to.be.rejected;
  });
});
