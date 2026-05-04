# Sealdex on Fly.io

Single-image deploy. One container runs the Next.js frontend, two
operator-owned demo bidders (Alpha + Beta), the BYOK spawn worker
(reconciles user-spawned bidders), and the auto-cycle loop.

## Required secrets (set once)

```bash
# Operator's Anthropic key — feeds the two demo bidders only.
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 32+ char random string. HMAC key for session cookies AND
# AES-256-GCM master for the BYOK encrypted-creds blobs.
# DO NOT rotate without first wiping /data/state/spawns/ —
# rotation makes existing encrypted blobs unreadable.
fly secrets set SEALDEX_SESSION_SECRET=$(openssl rand -hex 32)

# Solana keypairs as base64-encoded JSON arrays. First boot
# decodes these onto the persistent volume; subsequent boots
# reuse the on-volume copies.
fly secrets set SELLER_KEYPAIR_B64="$(base64 -w0 < /path/to/seller.json)"
fly secrets set BIDDER1_KEYPAIR_B64="$(base64 -w0 < /path/to/bidder1.json)"
fly secrets set BIDDER2_KEYPAIR_B64="$(base64 -w0 < /path/to/bidder2.json)"
```

If any of `ANTHROPIC_API_KEY` or `SEALDEX_SESSION_SECRET` is missing
the entrypoint refuses to start (loud message in `fly logs`). This
is intentional — silently running without a stable session secret
would lose every BYOK user's spawns on the next deploy.

## Optional toggles

- `SEALDEX_BYOK=0` — keep the demo bidders + frontend, skip the
  BYOK spawn worker entirely. Useful while debugging a worker
  regression in prod.
- `CYCLE_MODE=live` — disable the auto-cycle loop and let real
  sellers post auctions via the MCP server.
- `CYCLE_INTERVAL_SEC` — tune cycle period (default 600s).

## Deploy

```bash
fly deploy
fly logs --app sealdex
```

The first deploy after this iteration will need
`SEALDEX_SESSION_SECRET` set or the container will exit. Confirm
with `fly logs` that you see all four boot lines:

    [entrypoint] starting frontend
    [entrypoint] starting bidder-alpha
    [entrypoint] starting bidder-beta
    [entrypoint] starting spawn-worker

## Smoke tests

`scripts/smoke-iter24.sh` exercises the entrypoint in
`SEALDEX_DRY_RUN=1` mode — no children forked, just the command
lines printed. It validates:

- bash syntax
- all four processes are launched
- `SEALDEX_SESSION_SECRET` is required (and the error message
  is actionable)
- `SEALDEX_BYOK=0` skips the worker without requiring the secret
- runtime image copies the worker source

Run with: `bash scripts/smoke-iter24.sh`.

For a true end-to-end live test, pair this with the iter-22 and
iter-23 smokes:

```bash
yarn tsx frontend/lib/smoke-iter22.ts   # LLM-endpoint pluggability
yarn tsx frontend/lib/smoke-iter23.ts   # per-spawn stream tail
```

These hit the live Next.js dev server + worker — they don't run
under entrypoint.sh, but they exercise the same code paths.

## Volume layout

The `/data` volume holds:

```
/data/
├── .keys/                    Solana keypairs (mode 0600)
│   ├── seller.json
│   ├── bidder1.json
│   └── bidder2.json
└── state/
    ├── auction-registry.json   Operator-side registry feed
    ├── bidder-*-state.json     Demo-bidder per-name state
    ├── bidder-*-stream.jsonl   Demo-bidder activity stream
    ├── escrow-log.jsonl        Settlement audit trail
    └── spawns/                 BYOK per-user spawns
        ├── index.json
        └── <spawn-id>/
            ├── config.json
            ├── creds.enc.json   AES-256-GCM encrypted blob
            ├── creds-runtime/   Decrypted keypair (mode 0600,
            │                    cleared on stop)
            └── state/           Per-spawn bidder state + stream
```

Wiping `spawns/` is the only safe way to invalidate existing BYOK
sessions if the session secret is compromised. The other
directories are operator-owned and survive across BYOK rotations.
