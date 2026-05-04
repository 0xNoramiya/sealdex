#!/usr/bin/env bash
# Sealdex Fly entrypoint — runs frontend, two bidders, and the auto-cycle loop
# inside one container. Wallet keypairs are seeded from base64-encoded Fly
# secrets on first boot, then persist on the mounted volume.

set -euo pipefail

DATA_DIR=${DATA_DIR:-/data}
KEYS_DIR=${SEALDEX_KEYS_DIR:-$DATA_DIR/.keys}
STATE_DIR=${SEALDEX_STATE_DIR:-$DATA_DIR/state}

mkdir -p "$KEYS_DIR" "$STATE_DIR"

decode_keypair() {
  local name=$1
  local var=$2
  local out="$KEYS_DIR/${name}.json"
  if [ -f "$out" ]; then
    echo "[entrypoint] $name keypair already on volume — keeping it"
    return
  fi
  if [ -z "${!var:-}" ]; then
    echo "[entrypoint] FATAL: $var not set and $out missing — set the Fly secret" >&2
    exit 1
  fi
  echo "[entrypoint] writing $name keypair from $var"
  echo "${!var}" | base64 -d > "$out"
  chmod 600 "$out"
}

decode_keypair seller   SELLER_KEYPAIR_B64
decode_keypair bidder1  BIDDER1_KEYPAIR_B64
decode_keypair bidder2  BIDDER2_KEYPAIR_B64

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[entrypoint] FATAL: ANTHROPIC_API_KEY not set" >&2
  exit 1
fi

# Bidder configs reference keypair_path relative to repo root. Symlink the
# volume keys into /app so the existing configs resolve cleanly.
mkdir -p /app/.keys
ln -sf "$KEYS_DIR/bidder1.json" /app/.keys/bidder1.json
ln -sf "$KEYS_DIR/bidder2.json" /app/.keys/bidder2.json
ln -sf "$KEYS_DIR/seller.json"  /app/.keys/seller.json

# Background processes — captured PIDs so we can kill them on signal.
PIDS=()
trap 'echo "[entrypoint] shutting down"; kill "${PIDS[@]}" 2>/dev/null || true; wait || true' TERM INT

echo "[entrypoint] starting frontend on :$PORT"
( cd /app/frontend && PORT=${PORT:-3000} HOSTNAME=0.0.0.0 yarn next start ) &
PIDS+=($!)

echo "[entrypoint] starting Bidder Alpha"
( cd /app && node --import tsx agents/bidder/index.ts agents/bidder/configs/alpha.json ) &
PIDS+=($!)

echo "[entrypoint] starting Bidder Beta"
( cd /app && node --import tsx agents/bidder/index.ts agents/bidder/configs/beta.json ) &
PIDS+=($!)

# Give frontend + bidders a moment to settle before the first cycle.
sleep 6

# CYCLE_MODE=live skips auto-posting (cycle.sh self-noops). Demo mode posts
# fresh auctions on a timer so judges see live activity even when no human
# is sitting in the seller seat.
echo "[entrypoint] starting cycle loop (CYCLE_MODE=${CYCLE_MODE:-demo})"
/app/cycle.sh &
PIDS+=($!)

# Wait on whichever exits first; if the frontend dies the container should
# exit so Fly can restart it.
wait -n "${PIDS[@]}"
status=$?
echo "[entrypoint] one process exited with $status — bringing the container down"
kill "${PIDS[@]}" 2>/dev/null || true
exit $status
