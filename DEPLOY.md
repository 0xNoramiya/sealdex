# Deploying Sealdex to Fly.io

Single-app deploy: one container runs the Next.js frontend, two long-lived
bidder agents, and an auto-cycle loop that posts + settles auctions every
~10 minutes. Wallet keypairs are stored as Fly secrets and seeded onto a
persistent volume on first boot.

## Prerequisites

- A Fly.io account + `fly` CLI installed (`brew install flyctl` or
  `curl -L https://fly.io/install.sh | sh`)
- `fly auth login` completed
- Local wallets already generated and funded on devnet — the same `.keys/`
  files you use locally
- An Anthropic API key
- A Helius devnet RPC URL (recommended over the default devnet endpoint)

## One-time setup

```bash
# 1. Create the app and the persistent volume, but skip the deploy step —
#    we need to set secrets first.
fly launch --copy-config --no-deploy --name sealdex --region iad

# 2. Set the Anthropic key.
fly secrets set ANTHROPIC_API_KEY="sk-ant-…"

# 3. Override the default RPC with Helius.
fly secrets set SOLANA_RPC_URL="https://devnet.helius-rpc.com/?api-key=<your-key>"

# 4. Encode the three wallet keypairs as base64 and store them as secrets.
#    The entrypoint will decode them onto the persistent volume on first boot.
fly secrets set \
  SELLER_KEYPAIR_B64="$(base64 -w0 .keys/seller.json)" \
  BIDDER1_KEYPAIR_B64="$(base64 -w0 .keys/bidder1.json)" \
  BIDDER2_KEYPAIR_B64="$(base64 -w0 .keys/bidder2.json)"

# 5. Deploy.
fly deploy

# 6. Tail the logs for the first cycle to make sure things land cleanly.
fly logs
```

You should see, in order:
- `[entrypoint] writing seller keypair from SELLER_KEYPAIR_B64`
- `[entrypoint] starting frontend on :3000`
- `[entrypoint] starting Bidder Alpha`
- `[entrypoint] starting Bidder Beta`
- `[entrypoint] starting auto-cycle loop`
- `[cycle] === posting auctions ===`
- A few green ticks from the bidders, then a settle.

## Updating

Subsequent deploys are just `fly deploy`. The persistent volume keeps the
wallet keypairs and the registry/state files between releases, so the bidder
loop picks up where it left off.

## Rotating the Anthropic key

```bash
fly secrets set ANTHROPIC_API_KEY="sk-ant-…"   # triggers a rolling restart
```

## Rotating wallet keypairs

If you need to swap a wallet (lost key, refunding from a fresh airdrop, etc.):

```bash
fly ssh console
rm /data/.keys/bidder1.json   # delete the stale one on the volume
exit
fly secrets set BIDDER1_KEYPAIR_B64="$(base64 -w0 .keys/bidder1.new.json)"
fly deploy --strategy=immediate   # forces re-seed from secret
```

## Cost estimate

- **Compute:** shared-cpu-1x with 1 GB memory ≈ $5.75/month
- **Volume:** 1 GB persistent = $0.15/month
- **Anthropic:** ~$0.012 per auction cycle. At one cycle / 10 minutes
  that's ≈ $1.73/day or **~$3.50 per 48-hour judging window**

Total for a one-week judging window: well under $10.

## Troubleshooting

**`/sales` shows mock data (`Bidder Alpha/Beta/Gamma`):**
The bidders couldn't write to the registry, or the frontend can't read it.
SSH in and check:
```bash
fly ssh console
ls -la /data/state/
cat /data/state/auction-registry.json | head
```

**Auction never settles:**
The seller wallet ran out of devnet SOL. Top it up:
```bash
solana airdrop 1 $(solana-keygen pubkey .keys/seller.json) --url devnet
fly secrets set SELLER_KEYPAIR_B64="$(base64 -w0 .keys/seller.json)"  # no-op
fly machine restart   # actually just kicks the cycle
```

**Bidder placed_bid succeeds but settle reverts with custom 6005:**
The bid PDA was probably created on a previous cycle for the same
`auction_id`. Cycle IDs are monotonic timestamps, so this only happens if
the system clock jumped back. Check with `fly ssh console` then `date`.

**Anthropic 401:**
Bad / rotated key. `fly secrets set ANTHROPIC_API_KEY="..."` again.
