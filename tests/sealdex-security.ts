// Security regression tests. These cover invariants that aren't visible in
// the happy-path test (`sealdex-auction.ts`) — duplicate-create rejection,
// payment_mint enforcement, force-cancel safety, and so on.
//
// Each `it` is independently scoped: it generates its own auction_id and a
// fresh attacker keypair so a failure in one doesn't poison the others.

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";

const AUCTION_SEED = Buffer.from("auction");

describe("sealdex-security", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // Untyped on purpose — the generated types/sealdex_auction.ts file is
  // produced by `anchor build` and is .gitignored. This test relies only
  // on the runtime IDL loaded from anchor.workspace.
  const program = anchor.workspace.SealdexAuction as anchor.Program;
  const seller = provider.wallet.payer;

  // 24h in the future — plenty of headroom; we never wait it out.
  const farFutureEnd = () =>
    new BN(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
  const lotMetadataUri = "ipfs://bafyfakecid/security-test.json";
  const paymentMint = PublicKey.default;

  function auctionPdaFor(id: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [AUCTION_SEED, id.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  }

  it("rejects a duplicate create_auction at the same auction_id", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);

    const createIx = await program.methods
      .createAuction(
        auctionId,
        lotMetadataUri,
        paymentMint,
        farFutureEnd(),
        new BN(10_000_000),
        new BN(60),
        { firstPrice: {} },
        [],
        new BN(0),
        new BN(0)
      )
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx1 = new Transaction().add(createIx);
    tx1.feePayer = seller.publicKey;
    const sig1 = await sendAndConfirmTransaction(
      provider.connection,
      tx1,
      [seller],
      { skipPreflight: true, commitment: "confirmed" }
    );
    console.log("first create_auction:", sig1);

    // Second attempt must fail because Anchor `init` rejects existing PDAs.
    let threw = false;
    try {
      const createIx2 = await program.methods
        .createAuction(
          auctionId,
          "ipfs://attacker-overwrite.json",
          paymentMint,
          farFutureEnd(),
          new BN(10_000_000),
          new BN(60),
          { firstPrice: {} },
          [],
          new BN(0),
          new BN(0)
        )
        .accounts({
          // @ts-ignore
          auction: auctionPda,
          seller: seller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx2 = new Transaction().add(createIx2);
      tx2.feePayer = seller.publicKey;
      await sendAndConfirmTransaction(provider.connection, tx2, [seller], {
        skipPreflight: true,
        commitment: "confirmed",
      });
    } catch (err) {
      threw = true;
      const msg = (err as Error).message ?? String(err);
      // The exact shape varies — Anchor sometimes surfaces "already in use",
      // sometimes "AccountDiscriminatorAlreadySet", sometimes a generic
      // "Transaction resulted in an error" with the program error in logs.
      // Any non-empty failure here means `init` did its job; the regression
      // we're guarding against is the SUCCESS case where init_if_needed
      // silently overwrote.
      console.log("second create_auction rejected:", msg.split("\n")[0]);
      expect(msg.length).to.be.greaterThan(0);
    }
    expect(threw, "second create_auction should have failed").to.equal(true);

    // And the on-chain seller field still belongs to the original creator —
    // not silently overwritten.
    const info = await provider.connection.getAccountInfo(auctionPda);
    expect(info, "auction account should still exist").to.not.be.null;
    const decoded = program.coder.accounts.decode("auction", info!.data);
    expect(decoded.seller.toBase58()).to.equal(seller.publicKey.toBase58());
    expect(decoded.lotMetadataUri).to.equal(lotMetadataUri);
  });

  it("rejects create_auction with bid_deposit_lamports below MIN", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    let threw = false;
    try {
      const ix = await program.methods
        .createAuction(
          auctionId,
          lotMetadataUri,
          paymentMint,
          farFutureEnd(),
          new BN(1_000_000), // 0.001 SOL — below 0.01 floor
          new BN(60),
          { firstPrice: {} },
          [],
          new BN(0),
          new BN(0)
        )
        .accounts({
          // @ts-ignore
          auction: auctionPda,
          seller: seller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = seller.publicKey;
      await sendAndConfirmTransaction(provider.connection, tx, [seller], {
        skipPreflight: true,
        commitment: "confirmed",
      });
    } catch (err) {
      threw = true;
      console.log(
        "deposit floor enforced:",
        ((err as Error).message ?? String(err)).split("\n")[0]
      );
    }
    expect(threw, "create_auction with deposit < MIN should fail").to.equal(
      true
    );
  });

  it("rejects create_auction with claim_grace_seconds outside bounds", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    let threw = false;
    try {
      const ix = await program.methods
        .createAuction(
          auctionId,
          lotMetadataUri,
          paymentMint,
          farFutureEnd(),
          new BN(10_000_000),
          new BN(10), // below MIN_CLAIM_GRACE_SECONDS=60
          { firstPrice: {} },
          [],
          new BN(0),
          new BN(0)
        )
        .accounts({
          // @ts-ignore
          auction: auctionPda,
          seller: seller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = seller.publicKey;
      await sendAndConfirmTransaction(provider.connection, tx, [seller], {
        skipPreflight: true,
        commitment: "confirmed",
      });
    } catch (err) {
      threw = true;
      console.log(
        "claim_grace bounds enforced:",
        ((err as Error).message ?? String(err)).split("\n")[0]
      );
    }
    expect(threw).to.equal(true);
  });

  it("rejects place_bid with deposit_lamports below MIN", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    // Create the auction first so the bid PDA derivation has a real auction.
    const createIx = await program.methods
      .createAuction(
        auctionId,
        lotMetadataUri,
        paymentMint,
        farFutureEnd(),
        new BN(10_000_000),
        new BN(60),
        { firstPrice: {} },
        [],
        new BN(0),
        new BN(0)
      )
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const createTx = new Transaction().add(createIx);
    createTx.feePayer = seller.publicKey;
    await sendAndConfirmTransaction(provider.connection, createTx, [seller], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    // Now try to bid with too-small deposit. NB: this auction is NOT
    // delegated, so we're just exercising the deposit-floor branch in
    // place_bid before it would otherwise be in-flight to the TEE.
    const bidder = anchor.web3.Keypair.generate();
    const fundIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: seller.publicKey,
      toPubkey: bidder.publicKey,
      lamports: 0.05 * anchor.web3.LAMPORTS_PER_SOL,
    });
    const fundTx = new Transaction().add(fundIx);
    fundTx.feePayer = seller.publicKey;
    await sendAndConfirmTransaction(provider.connection, fundTx, [seller], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    const bidPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bid"),
        auctionId.toArrayLike(Buffer, "le", 8),
        bidder.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    let threw = false;
    try {
      const ix = await program.methods
        .placeBid(auctionId, new BN(1_000_000_000), new BN(1_000_000)) // 0.001 SOL deposit, below floor
        .accounts({
          // @ts-ignore
          bid: bidPda,
          bidder: bidder.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = bidder.publicKey;
      await sendAndConfirmTransaction(provider.connection, tx, [bidder], {
        skipPreflight: true,
        commitment: "confirmed",
      });
    } catch (err) {
      threw = true;
      console.log(
        "place_bid deposit floor enforced:",
        ((err as Error).message ?? String(err)).split("\n")[0]
      );
    }
    expect(threw, "place_bid with deposit < MIN should fail").to.equal(true);
  });

  it("rejects create_auction whose permitted_bidders contains duplicates", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    const dup = anchor.web3.Keypair.generate().publicKey;
    let threw = false;
    try {
      const ix = await program.methods
        .createAuction(
          auctionId,
          lotMetadataUri,
          paymentMint,
          farFutureEnd(),
          new BN(10_000_000),
          new BN(60),
          { firstPrice: {} },
          [dup, dup], // duplicate
          new BN(0),
          new BN(0)
        )
        .accounts({
          // @ts-ignore
          auction: auctionPda,
          seller: seller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = seller.publicKey;
      await sendAndConfirmTransaction(provider.connection, tx, [seller], {
        skipPreflight: true,
        commitment: "confirmed",
      });
    } catch (err) {
      threw = true;
      console.log(
        "duplicate permitted_bidders rejected:",
        ((err as Error).message ?? String(err)).split("\n")[0]
      );
    }
    expect(threw).to.equal(true);
  });

  it("create_auction stores permitted_bidders intact", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    const allowed = [
      anchor.web3.Keypair.generate().publicKey,
      anchor.web3.Keypair.generate().publicKey,
      anchor.web3.Keypair.generate().publicKey,
    ];
    const ix = await program.methods
      .createAuction(
        auctionId,
        lotMetadataUri,
        paymentMint,
        farFutureEnd(),
        new BN(10_000_000),
        new BN(60),
        { firstPrice: {} },
        allowed,
        new BN(0),
        new BN(0)
      )
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = seller.publicKey;
    await sendAndConfirmTransaction(provider.connection, tx, [seller], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    const info = await provider.connection.getAccountInfo(auctionPda);
    expect(info, "auction account should be initialized").to.not.be.null;
    const decoded = program.coder.accounts.decode("auction", info!.data);
    const stored: PublicKey[] = decoded.permittedBidders;
    expect(stored.length).to.equal(allowed.length);
    for (let i = 0; i < allowed.length; i++) {
      expect(stored[i].toBase58()).to.equal(allowed[i].toBase58());
    }
    console.log(
      `permitted_bidders stored: [${stored.map((p) => p.toBase58().slice(0, 4)).join(", ")}]`
    );
  });

  it("rejects create_auction when bid_deposit < market_floor (estimate_high_usdc)", async () => {
    // 1% of $5_000 × 5_000_000 lamports/USDC = 2_500_000_000 lamports
    // (~2.5 SOL). Submitting only 0.01 SOL should be rejected by the
    // program's market-floor check, not the hard MIN_BID_DEPOSIT_LAMPORTS.
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    let threw = false;
    try {
      const ix = await program.methods
        .createAuction(
          auctionId,
          lotMetadataUri,
          paymentMint,
          farFutureEnd(),
          new BN(10_000_000), // hard floor only — well below the market floor
          new BN(60),
          { firstPrice: {} },
          [],
          new BN(5_000), // $5,000 lot
          new BN(0)
        )
        .accounts({
          // @ts-ignore
          auction: auctionPda,
          seller: seller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = seller.publicKey;
      await sendAndConfirmTransaction(provider.connection, tx, [seller], {
        skipPreflight: true,
        commitment: "confirmed",
      });
    } catch (err) {
      threw = true;
      console.log(
        "market floor enforced:",
        ((err as Error).message ?? String(err)).split("\n")[0]
      );
    }
    expect(threw, "create_auction should reject sub-market deposit").to.equal(
      true
    );
  });

  it("accepts create_auction when bid_deposit_lamports meets the market floor", async () => {
    // 1% of $5_000 = 2_500_000_000 lamports. Pass exactly that.
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    const ix = await program.methods
      .createAuction(
        auctionId,
        lotMetadataUri,
        paymentMint,
        farFutureEnd(),
        new BN(2_500_000_000), // matches the market floor
        new BN(60),
        { firstPrice: {} },
        [],
        new BN(5_000),
        new BN(0)
      )
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = seller.publicKey;
    const sig = await sendAndConfirmTransaction(
      provider.connection,
      tx,
      [seller],
      { skipPreflight: true, commitment: "confirmed" }
    );
    console.log(`market floor accepted: ${sig}`);

    const info = await provider.connection.getAccountInfo(auctionPda);
    const decoded = program.coder.accounts.decode("auction", info!.data);
    expect(decoded.estimateHighUsdc.toNumber()).to.equal(5_000);
    expect(decoded.bidDepositLamports.toString()).to.equal("2500000000");
  });

  it("create_auction emits an AuctionCreated event in tx logs", async () => {
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    const ix = await program.methods
      .createAuction(
        auctionId,
        lotMetadataUri,
        paymentMint,
        farFutureEnd(),
        // 1% × $1000 × 5M lamports/USDC = 50_000_000 lamports market floor
        new BN(50_000_000),
        new BN(60),
        { firstPrice: {} },
        [],
        new BN(1_000), // estimate_high_usdc — also goes into the event
        new BN(0)
      )
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = seller.publicKey;
    const sig = await sendAndConfirmTransaction(
      provider.connection,
      tx,
      [seller],
      { skipPreflight: true, commitment: "confirmed" }
    );

    const txDetails = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(txDetails).to.not.be.null;
    const logs = txDetails!.meta!.logMessages ?? [];
    const eventParser = new anchor.EventParser(
      program.programId,
      program.coder
    );
    const events = Array.from(eventParser.parseLogs(logs));
    const created = events.find(
      (e) => e.name === "AuctionCreated" || e.name === "auctionCreated"
    );
    expect(created, "expected AuctionCreated event in logs").to.not.be.undefined;
    expect((created!.data as any).auctionId.toString()).to.equal(
      auctionId.toString()
    );
    expect((created!.data as any).estimateHighUsdc.toNumber()).to.equal(1_000);
    expect((created!.data as any).kindIsSecondPrice).to.equal(false);
    expect((created!.data as any).permittedBidderCount).to.equal(0);
    console.log(
      `AuctionCreated event decoded for auction ${auctionId.toString()}`
    );
  });

  it("create_auction stores reserve_price intact on the PDA", async () => {
    // 50_000_000_000 native units = $50_000 in micro-USDC (6 decimals).
    // Round-trip decode it after create to confirm the wire-up.
    const reserve = new BN("50000000000");
    const auctionId = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const auctionPda = auctionPdaFor(auctionId);
    const ix = await program.methods
      .createAuction(
        auctionId,
        lotMetadataUri,
        paymentMint,
        farFutureEnd(),
        new BN(10_000_000),
        new BN(60),
        { firstPrice: {} },
        [],
        new BN(0),
        reserve
      )
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = seller.publicKey;
    await sendAndConfirmTransaction(provider.connection, tx, [seller], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    const info = await provider.connection.getAccountInfo(auctionPda);
    const decoded = program.coder.accounts.decode("auction", info!.data);
    expect(decoded.reservePrice.toString()).to.equal("50000000000");
    console.log(
      `reserve_price round-trip: stored=${decoded.reservePrice.toString()}`
    );
  });
});
