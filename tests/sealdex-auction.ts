import * as anchor from "@coral-xyz/anchor";
import { sendAndConfirmTransaction } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { SealdexAuction } from "../target/types/sealdex_auction";
import BN from "bn.js";
import * as nacl from "tweetnacl";

import {
  permissionPdaFromAccount,
  getAuthToken,
  waitUntilPermissionActive,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  Member,
  createDelegatePermissionInstruction,
} from "@magicblock-labs/ephemeral-rollups-sdk";

describe("sealdex-auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SealdexAuction as Program<SealdexAuction>;
  console.log("Program ID:", program.programId.toString());

  const ER_VALIDATOR = new anchor.web3.PublicKey(
    "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
  );
  const teeUrl = "https://devnet-tee.magicblock.app";
  const teeWsUrl = "wss://devnet-tee.magicblock.app";
  const ephemeralRpcEndpoint = (
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || teeUrl
  ).replace(/\/$/, "");

  const providerEphemeralRollup = new anchor.AnchorProvider(
    new anchor.web3.Connection(ephemeralRpcEndpoint, {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || teeWsUrl,
    }),
    anchor.Wallet.local()
  );
  console.log("Base Layer Connection:", provider.connection.rpcEndpoint);
  console.log(
    "Ephemeral Rollup Connection:",
    providerEphemeralRollup.connection.rpcEndpoint
  );

  const seller = provider.wallet.payer;
  const bidderA = anchor.web3.Keypair.generate();
  const bidderB = anchor.web3.Keypair.generate();
  const bidderC = anchor.web3.Keypair.generate();
  const allBidders = [bidderA, bidderB, bidderC];

  const auctionId = new BN(Date.now());
  const auctionDurationSec = 12;
  let endTime: BN;
  let clockSkewSec = 0; // localNow - clusterNow

  async function getClusterUnixTime(): Promise<number> {
    const slot = await provider.connection.getSlot();
    const t = await provider.connection.getBlockTime(slot);
    if (!t) throw new Error("cluster getBlockTime returned null");
    return t;
  }

  const lotMetadataUri =
    "ipfs://bafyfakecid/sealdex-lot-001.json";
  // Demo SPL mint placeholder — actual escrow flow uses Private Payments later.
  const paymentMint = anchor.web3.PublicKey.default;

  const AUCTION_SEED = Buffer.from("auction");
  const BID_SEED = Buffer.from("bid");

  const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [AUCTION_SEED, auctionId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const bidPdas = allBidders.map(
    (b) =>
      anchor.web3.PublicKey.findProgramAddressSync(
        [BID_SEED, auctionId.toArrayLike(Buffer, "le", 8), b.publicKey.toBuffer()],
        program.programId
      )[0]
  );

  const permissionAuction = permissionPdaFromAccount(auctionPda);
  const permissionBids = bidPdas.map((p) => permissionPdaFromAccount(p));

  console.log("Seller:", seller.publicKey.toBase58());
  allBidders.forEach((b, i) =>
    console.log(`Bidder ${"ABC"[i]}:`, b.publicKey.toBase58())
  );
  console.log("Auction PDA:", auctionPda.toBase58());
  bidPdas.forEach((p, i) =>
    console.log(`Bid ${"ABC"[i]} PDA:`, p.toBase58())
  );

  // TEE auth tokens, populated after airdrop
  const teeProviders: anchor.AnchorProvider[] = [];

  it("Funds bidders and acquires TEE auth tokens", async () => {
    const tx = new anchor.web3.Transaction().add(
      ...allBidders.map((b) =>
        anchor.web3.SystemProgram.transfer({
          fromPubkey: seller.publicKey,
          toPubkey: b.publicKey,
          lamports: 0.1 * anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );
    await provider.sendAndConfirm(tx, [seller]);
    for (const b of allBidders) {
      const bal = await provider.connection.getBalance(b.publicKey);
      console.log(
        `💸 ${b.publicKey.toBase58().slice(0, 4)}… : ${bal / anchor.web3.LAMPORTS_PER_SOL} SOL`
      );
    }

    if (ephemeralRpcEndpoint.includes("tee")) {
      for (const b of [seller, ...allBidders]) {
        const tok = await getAuthToken(
          ephemeralRpcEndpoint,
          b.publicKey,
          (msg: Uint8Array) =>
            Promise.resolve(nacl.sign.detached(msg, b.secretKey))
        );
        teeProviders.push(
          new anchor.AnchorProvider(
            new anchor.web3.Connection(`${teeUrl}?token=${tok.token}`, {
              wsEndpoint: `${teeWsUrl}?token=${tok.token}`,
            }),
            anchor.Wallet.local()
          )
        );
      }
    }
  });

  it("Seller creates auction and delegates", async () => {
    const clusterNow = await getClusterUnixTime();
    clockSkewSec = Math.floor(Date.now() / 1000) - clusterNow;
    console.log(`Cluster→local clock skew: ${clockSkewSec}s`);
    endTime = new BN(clusterNow + auctionDurationSec);

    const createIx = await program.methods
      .createAuction(auctionId, lotMetadataUri, paymentMint, endTime)
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        seller: seller.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    // Auction permission allows seller + all 3 bidders to read/write the auction PDA.
    const auctionMembers: Member[] = [seller, ...allBidders].map((kp) => ({
      flags: AUTHORITY_FLAG | TX_LOGS_FLAG,
      pubkey: kp.publicKey,
    }));
    const createPermAuctionIx = await program.methods
      .createPermission({ auction: { auctionId } }, auctionMembers)
      .accountsPartial({
        payer: seller.publicKey,
        permissionedAccount: auctionPda,
        permission: permissionAuction,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const delegatePermAuctionIx = createDelegatePermissionInstruction({
      payer: seller.publicKey,
      validator: ER_VALIDATOR,
      permissionedAccount: [auctionPda, false],
      authority: [seller.publicKey, true],
    });
    const delegateAuctionIx = await program.methods
      .delegatePda({ auction: { auctionId } })
      .accounts({
        payer: seller.publicKey,
        validator: ER_VALIDATOR,
        pda: auctionPda,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(
      createIx,
      createPermAuctionIx,
      delegatePermAuctionIx,
      delegateAuctionIx
    );
    tx.feePayer = seller.publicKey;
    const sig = await sendAndConfirmTransaction(provider.connection, tx, [seller], {
      skipPreflight: true,
      commitment: "confirmed",
    });
    console.log("✅ Auction created & delegated:", sig);

    const ok = await waitUntilPermissionActive(ephemeralRpcEndpoint, auctionPda);
    console.log("Auction permission active:", ok);
  });

  const bidAmounts = [
    new BN(2_890_000_000), // bidderA — 2,890 USDC (6 decimals)
    new BN(3_150_000_000), // bidderB — 3,150 USDC ← winner
    new BN(2_640_000_000), // bidderC — 2,640 USDC
  ];

  it("Each bidder places a sealed bid", async () => {
    for (let i = 0; i < allBidders.length; i++) {
      const b = allBidders[i];
      const placeIx = await program.methods
        .placeBid(auctionId, bidAmounts[i])
        .accounts({
          // @ts-ignore
          bid: bidPdas[i],
          bidder: b.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction();

      // Bid permission: only this bidder
      const members: Member[] = [
        { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: b.publicKey },
      ];
      const createPermBidIx = await program.methods
        .createPermission(
          { bid: { auctionId, bidder: b.publicKey } },
          members
        )
        .accountsPartial({
          payer: b.publicKey,
          permissionedAccount: bidPdas[i],
          permission: permissionBids[i],
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction();
      const delegatePermBidIx = createDelegatePermissionInstruction({
        payer: b.publicKey,
        validator: ER_VALIDATOR,
        permissionedAccount: [bidPdas[i], false],
        authority: [b.publicKey, true],
      });
      const delegateBidIx = await program.methods
        .delegatePda({ bid: { auctionId, bidder: b.publicKey } })
        .accounts({
          payer: b.publicKey,
          validator: ER_VALIDATOR,
          pda: bidPdas[i],
        })
        .instruction();

      const tx = new anchor.web3.Transaction().add(
        placeIx,
        createPermBidIx,
        delegatePermBidIx,
        delegateBidIx
      );
      tx.feePayer = b.publicKey;
      const sig = await sendAndConfirmTransaction(provider.connection, tx, [b], {
        skipPreflight: true,
        commitment: "confirmed",
      });
      console.log(
        `✅ Bid ${"ABC"[i]} placed (${bidAmounts[i].toString()}):`,
        sig
      );
      const ok = await waitUntilPermissionActive(
        ephemeralRpcEndpoint,
        bidPdas[i]
      );
      console.log(`Bid ${"ABC"[i]} permission active:`, ok);
    }
  });

  it("Bidder can read OWN bid via TEE auth", async () => {
    // teeProviders index 0 = seller, 1 = bidderA, 2 = bidderB, 3 = bidderC
    for (let i = 0; i < allBidders.length; i++) {
      const tee = teeProviders[i + 1];
      const info = await tee.connection.getAccountInfo(bidPdas[i]);
      if (!info) throw new Error(`Bidder ${"ABC"[i]} cannot read own bid!`);
      const decoded = program.coder.accounts.decode("bid", info.data);
      console.log(
        `👀 Bidder ${"ABC"[i]} sees own bid amount:`,
        decoded.amount.toString()
      );
    }
  });

  it("Bidder CANNOT read another bidder's bid (sealed)", async () => {
    // Bidder A tries to read bidder B's PDA via A's TEE auth — must be null
    const teeA = teeProviders[1];
    const info = await teeA.connection.getAccountInfo(bidPdas[1]); // B's bid
    if (info !== null) {
      throw new Error("❌ Bidder A read bidder B's sealed bid amount!");
    }
    console.log("✅ Bidder A blocked from reading bidder B's bid (sealed).");
  });

  it("Settles after end_time and verifies winner on base Solana", async () => {
    // Wait until the CLUSTER clock crosses end_time. Local clock is ~30s skewed.
    const localTargetMs = (endTime.toNumber() + clockSkewSec) * 1000 + 3000;
    const waitMs = localTargetMs - Date.now();
    if (waitMs > 0) {
      console.log(`⏳ Waiting ${(waitMs / 1000).toFixed(1)}s for cluster end_time…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const settleTx = await program.methods
      .settleAuction()
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        permissionAuction,
        payer: seller.publicKey,
      })
      .remainingAccounts(
        bidPdas.map((p) => ({ pubkey: p, isSigner: false, isWritable: false }))
      )
      .transaction();
    settleTx.feePayer = seller.publicKey;
    const teeSeller = teeProviders[0];
    const settleSig = await sendAndConfirmTransaction(
      teeSeller.connection,
      settleTx,
      [seller],
      { skipPreflight: true, commitment: "confirmed" }
    );
    console.log("✅ settle_auction tx:", settleSig);

    // Poll base Solana until the auction state is committed
    let auctionState: any;
    for (let i = 0; i < 20; i++) {
      const info = await provider.connection.getAccountInfo(auctionPda);
      if (info) {
        auctionState = program.coder.accounts.decode("auction", info.data);
        if (auctionState.status?.settled !== undefined) break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log("🏁 Auction (base Solana):", {
      status: auctionState.status,
      winner: auctionState.winner?.toBase58?.(),
      winning_bid: auctionState.winningBid?.toString?.(),
    });

    if (auctionState.status?.settled === undefined) {
      throw new Error("Auction did not reach Settled status on base Solana");
    }
    if (auctionState.winner.toBase58() !== bidderB.publicKey.toBase58()) {
      throw new Error(
        `Wrong winner! got ${auctionState.winner.toBase58()} expected ${bidderB.publicKey.toBase58()}`
      );
    }
    if (auctionState.winningBid.toString() !== bidAmounts[1].toString()) {
      throw new Error(
        `Wrong winning bid! got ${auctionState.winningBid.toString()} expected ${bidAmounts[1].toString()}`
      );
    }
    console.log("✅ Winner is Bidder B with $3,150.00 (sealed-bid auction works).");
  });

  it("Winner claims the lot and emits LotClaimed", async () => {
    const claimTx = await program.methods
      .claimLot()
      .accounts({
        // @ts-ignore
        auction: auctionPda,
        winner: bidderB.publicKey,
      })
      .transaction();
    claimTx.feePayer = bidderB.publicKey;
    const sig = await sendAndConfirmTransaction(
      provider.connection,
      claimTx,
      [bidderB],
      { skipPreflight: true, commitment: "confirmed" }
    );
    console.log("✅ claim_lot tx:", sig);
    const txDetails = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = txDetails?.meta?.logMessages?.filter((l) =>
      l.includes("Program data:")
    );
    console.log("LotClaimed event log entries:", logs?.length ?? 0);
  });
});
