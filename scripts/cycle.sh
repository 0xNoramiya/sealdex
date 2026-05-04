#!/usr/bin/env bash
# Auto-cycle loop. Posts a fresh auction every CYCLE_INTERVAL_SEC, lets the
# bidders evaluate, settles after expiry, then sleeps so judges who land
# during the post-reveal window still see the result.
#
# Tunable via env:
#   CYCLE_MODE          "demo" (default) — auto-post + auto-settle on a timer.
#                       "live" — exit immediately and let real sellers drive
#                       activity through the MCP server / public API.
#   CYCLE_INTERVAL_SEC  total cycle period in seconds (default 600 = 10 min)
#   CYCLE_DURATION_SEC  unused — auction duration is read from
#                        scripts/seed-inventory.json (default 90s in repo)

set -uo pipefail

MODE=${CYCLE_MODE:-demo}
if [ "$MODE" = "live" ]; then
  echo "[cycle] CYCLE_MODE=live — auto-cycle disabled. Real sellers should"
  echo "[cycle] post auctions via the MCP server (createAuction) or the"
  echo "[cycle] /api/auctions feed. Sleeping forever to keep the container alive."
  # `sleep infinity` so the process doesn't exit; entrypoint waits on it.
  exec sleep infinity
fi

INTERVAL=${CYCLE_INTERVAL_SEC:-600}
STATE_DIR=${SEALDEX_STATE_DIR:-/data/state}
REGISTRY=$STATE_DIR/auction-registry.json

cd /app

cycle() {
  echo "[cycle] === posting auctions ==="
  if ! node --import tsx agents/auctioneer/index.ts; then
    echo "[cycle] auctioneer failed — skipping this cycle"
    return 1
  fi

  # Auctions in seed-inventory default to 90s. Wait long enough for the
  # bidders to evaluate AND the auction window to expire on cluster.
  echo "[cycle] waiting 110s for sealed phase + bidder evaluation"
  sleep 110

  # Settle every entry that hasn't been settled yet. We re-read the registry
  # each iteration and use jq-free node to extract IDs, then call settle.
  ids=$(node -e "
    const fs = require('fs');
    try {
      const r = JSON.parse(fs.readFileSync('$REGISTRY','utf8'));
      // Settle the last 2 (this cycle's freshly-posted lots).
      console.log(r.slice(-2).map(e => e.auctionId).join(' '));
    } catch (e) { process.exit(0); }
  ") || true

  for id in $ids; do
    echo "[cycle] settling $id"
    if ! node --import tsx scripts/settle.ts "$id"; then
      echo "[cycle] settle of $id failed — continuing"
    fi
  done

  # Sleep the rest of the interval so the reveal stays on screen.
  remaining=$(( INTERVAL - 130 ))
  if [ $remaining -lt 60 ]; then remaining=60; fi
  echo "[cycle] === sleeping ${remaining}s before next cycle ==="
  sleep "$remaining"
}

while true; do
  cycle || sleep 60
done
