#!/usr/bin/env node
// MCP stdio server — exposes Sealdex auction operations as tools.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  claimLot,
  createAuction,
  endTimeFromNow,
  getAuctionsByIds,
  getAuctionState,
  placeBid,
  recoverBidInTee,
  refundBid,
  settleAuction,
  slashWinner,
} from "./ops.js";

const server = new Server(
  { name: "sealdex", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "create_auction",
    description:
      "Create a sealed-bid auction on Sealdex. The auction PDA and its permission account are created and delegated to the MagicBlock TEE in a single transaction. Returns the auction PDA + signature.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: {
          type: "string",
          description: "u64 as decimal string. Must be unique.",
        },
        lotMetadataUri: {
          type: "string",
          description: "IPFS or Arweave URI describing the lot. Max 200 chars.",
        },
        paymentMint: {
          type: "string",
          description:
            "Base58 SPL mint pubkey for settlement (devnet USDC or demo SPL).",
        },
        endTimeUnix: {
          type: "integer",
          description:
            "Unix timestamp (seconds) at which bidding closes. Use cluster time, not local.",
        },
        sellerKeypairPath: {
          type: "string",
          description: "Path to seller's keypair JSON file.",
        },
        permittedMembers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bidder pubkeys to grant TEE permission to read/write auction PDA.",
        },
      },
      required: [
        "auctionId",
        "lotMetadataUri",
        "paymentMint",
        "endTimeUnix",
        "sellerKeypairPath",
      ],
    },
  },
  {
    name: "place_bid",
    description:
      "Place a sealed bid on an auction. The bid amount is hidden inside Intel TDX hardware until the seller settles. Bids placed after end_time are rejected at settle time.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string", description: "u64 as decimal string." },
        amount: {
          type: "string",
          description:
            "Bid amount in native units of the payment mint (u64 as decimal string).",
        },
        bidderKeypairPath: {
          type: "string",
          description: "Path to bidder's keypair JSON file.",
        },
      },
      required: ["auctionId", "amount", "bidderKeypairPath"],
    },
  },
  {
    name: "get_auction_state",
    description:
      "Read a single auction's state from base Solana. Returns null while the auction is delegated to TEE (in-flight) and full state once settled.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string" },
      },
      required: ["auctionId"],
    },
  },
  {
    name: "get_auctions_by_ids",
    description:
      "Look up multiple auctions by ID. Returns settled state on base Solana, or {status: 'InFlight'} for currently-delegated auctions.",
    inputSchema: {
      type: "object",
      properties: {
        auctionIds: { type: "array", items: { type: "string" } },
      },
      required: ["auctionIds"],
    },
  },
  {
    name: "settle_auction",
    description:
      "Settle an auction inside the TEE — finds the highest bid among the supplied bid PDAs, sets winner on the auction account, and commits state back to base Solana. Caller pays gas.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string" },
        payerKeypairPath: { type: "string" },
        bidderPubkeys: {
          type: "array",
          items: { type: "string" },
          description:
            "Base58 pubkeys of all bidders whose Bid PDAs to consider. Order doesn't matter; duplicates are rejected.",
        },
      },
      required: ["auctionId", "payerKeypairPath", "bidderPubkeys"],
    },
  },
  {
    name: "claim_lot",
    description:
      "Winner-only. Marks the auction as Claimed and emits a LotClaimed event consumed by the escrow agent to trigger payment.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string" },
        winnerKeypairPath: { type: "string" },
      },
      required: ["auctionId", "winnerKeypairPath"],
    },
  },
  {
    name: "refund_bid",
    description:
      "Loser refund. Closes the bidder's own bid PDA after settlement (any of Settled / Claimed / Slashed) and returns the deposit lamports. Rejected for the auction winner — they go through claim_lot or slash_winner.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string" },
        bidderKeypairPath: { type: "string" },
      },
      required: ["auctionId", "bidderKeypairPath"],
    },
  },
  {
    name: "slash_winner",
    description:
      "Slash a no-show winner. Anyone may call once `end_time + claim_grace_seconds` has elapsed. Forfeits the winner's deposit to the seller and marks the auction Slashed.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string" },
        callerKeypairPath: { type: "string" },
      },
      required: ["auctionId", "callerKeypairPath"],
    },
  },
  {
    name: "recover_bid_in_tee",
    description:
      "Stuck-bid liveness fallback. After a 7-day grace, the bidder undelegates their own bid PDA from the TEE back to base (with the amount zeroed for privacy). Use refund_bid afterwards to reclaim the deposit. Only invoke when the TEE / settler is unreachable; under normal flow, settle handles the undelegation.",
    inputSchema: {
      type: "object",
      properties: {
        auctionId: { type: "string" },
        bidderKeypairPath: { type: "string" },
      },
      required: ["auctionId", "bidderKeypairPath"],
    },
  },
  {
    name: "end_time_from_now",
    description:
      "Helper: returns a unix timestamp `seconds` in the future, anchored to the cluster clock (not local), so create_auction won't fail with EndTimeInPast on machines with clock skew.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "integer", description: "Seconds from cluster_now." },
      },
      required: ["seconds"],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params as {
    name: string;
    arguments: any;
  };
  try {
    let result: unknown;
    switch (name) {
      case "create_auction":
        result = await createAuction(args);
        break;
      case "place_bid":
        result = await placeBid(args);
        break;
      case "get_auction_state":
        result = await getAuctionState(args.auctionId);
        break;
      case "get_auctions_by_ids":
        result = await getAuctionsByIds(args.auctionIds);
        break;
      case "settle_auction":
        result = await settleAuction(args);
        break;
      case "claim_lot":
        result = await claimLot(args);
        break;
      case "refund_bid":
        result = await refundBid(args);
        break;
      case "slash_winner":
        result = await slashWinner(args);
        break;
      case "recover_bid_in_tee":
        result = await recoverBidInTee(args);
        break;
      case "end_time_from_now":
        result = { endTimeUnix: await endTimeFromNow(args.seconds) };
        break;
      default:
        throw new Error(`unknown tool ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool ${name} failed: ${err?.message ?? String(err)}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("sealdex MCP server connected on stdio\n");
