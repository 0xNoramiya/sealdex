## Sealdex single-image deploy.
## Runs: Next.js frontend (prod build) + 2 long-lived bidder agents +
## an auto-cycle bash loop that posts/settles auctions on a timer.

# ─── builder ────────────────────────────────────────────────────────────────
FROM node:22-bullseye AS builder

WORKDIR /app

# ─── source + deps ──────────────────────────────────────────────────────────
# The agents declare a file:../../mcp-server dependency, which yarn resolves
# at install time — so mcp-server/ has to exist on disk before agent installs
# can run. Copy all source up front, then install in dependency order.
# We trade some layer caching for correctness; the build is fine for a single
# deploy target.
COPY package.json yarn.lock tsconfig.json ./
COPY mcp-server/ mcp-server/
COPY agents/ agents/
COPY scripts/ scripts/
COPY target/idl/ target/idl/
COPY frontend/ frontend/

RUN yarn install --frozen-lockfile
RUN cd mcp-server      && yarn install --frozen-lockfile
RUN cd agents/auctioneer && yarn install --frozen-lockfile
RUN cd agents/bidder     && yarn install --frozen-lockfile
RUN cd agents/escrow     && yarn install --frozen-lockfile
RUN cd frontend          && yarn install --frozen-lockfile && yarn build

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:22-bullseye-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    SEALDEX_STATE_DIR=/data/state \
    SEALDEX_KEYS_DIR=/data/.keys \
    SEALDEX_IDL_PATH=/app/target/idl/sealdex_auction.json \
    SEALDEX_REGISTRY_URL= \
    SOLANA_RPC_URL=https://api.devnet.solana.com \
    EPHEMERAL_RPC_URL=https://devnet-tee.magicblock.app

WORKDIR /app

# Bring node_modules + built artifacts forward from builder.
# Each subdirectory's node_modules comes along because the agents and the
# mcp-server resolve their imports from their own package's tree.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/target ./target
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/agents ./agents
COPY --from=builder /app/mcp-server ./mcp-server
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/package.json ./frontend/package.json
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/next.config.mjs ./frontend/next.config.mjs

# Entrypoint + cycle scripts (committed to repo).
COPY scripts/entrypoint.sh /app/entrypoint.sh
COPY scripts/cycle.sh /app/cycle.sh
RUN chmod +x /app/entrypoint.sh /app/cycle.sh

EXPOSE 3000
CMD ["/app/entrypoint.sh"]
