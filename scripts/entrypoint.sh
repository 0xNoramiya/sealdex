#!/usr/bin/env bash
# Sealdex Fly entrypoint — runs frontend, two bidders, the BYOK spawn worker,
# and the auto-cycle loop inside one container. Wallet keypairs are seeded
# from base64-encoded Fly secrets on first boot, then persist on the
# mounted volume.
#
# BYOK / production secrets contract:
#   SEALDEX_SESSION_SECRET   Required if BYOK is on (default). 32+ char random
#                            string used as both the HMAC key for session
#                            cookies and the AES-256-GCM master for encrypting
#                            user-supplied creds at rest. Rotation invalidates
#                            all outstanding sessions AND makes existing
#                            encrypted blobs unreadable, so DO NOT rotate
#                            without first wiping <state>/spawns/.
#   ANTHROPIC_API_KEY        Operator's Anthropic key for the two demo bidders
#                            (Alpha + Beta). NOT used for BYOK spawns — those
#                            ride on the user-supplied key inside the
#                            encrypted blob.
#   SELLER_KEYPAIR_B64,
#   BIDDER1_KEYPAIR_B64,
#   BIDDER2_KEYPAIR_B64      base64 of the JSON-array secret-key bytes Solana
#                            keygen produces. First-boot only — the volume
#                            persists the decoded files thereafter.
#
# Dry-run mode (SEALDEX_DRY_RUN=1):
#   Prints the command lines that WOULD be launched and exits. Used by the
#   iter-24 smoke test to validate the entrypoint wiring without forking
#   long-lived children.

set -euo pipefail

DATA_DIR=${DATA_DIR:-/data}
APP_DIR=${SEALDEX_APP_DIR:-/app}
KEYS_DIR=${SEALDEX_KEYS_DIR:-$DATA_DIR/.keys}
STATE_DIR=${SEALDEX_STATE_DIR:-$DATA_DIR/state}
DRY_RUN=${SEALDEX_DRY_RUN:-0}

# BYOK is on by default. The operator can disable it (e.g. while debugging
# a BYOK-specific deploy issue) by setting SEALDEX_BYOK=0; the frontend
# routes still respond, but no spawn-worker is launched.
BYOK_ENABLED=${SEALDEX_BYOK:-1}

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

# BYOK requires a stable session secret. Without it, every container
# restart invalidates all outstanding sessions AND makes previously-
# encrypted creds unreadable (the AES-256-GCM master is HKDF-derived
# from this secret). Catch this at boot rather than after the first
# user signs in and gets confused.
if [ "$BYOK_ENABLED" = "1" ]; then
  if [ -z "${SEALDEX_SESSION_SECRET:-}" ] || [ "${#SEALDEX_SESSION_SECRET}" -lt 32 ]; then
    echo "[entrypoint] FATAL: SEALDEX_SESSION_SECRET unset or shorter than 32 chars." >&2
    echo "[entrypoint]        BYOK requires a stable secret — set with" >&2
    echo "[entrypoint]        \`fly secrets set SEALDEX_SESSION_SECRET=\$(openssl rand -hex 32)\`" >&2
    echo "[entrypoint]        or run with SEALDEX_BYOK=0 to disable BYOK entirely." >&2
    exit 1
  fi
fi

# Bidder configs reference keypair_path relative to repo root. Symlink the
# volume keys into APP_DIR so the existing configs resolve cleanly. Skipped
# in dry-run because /app is owned by root in the prod image and writable
# only by the container — the local smoke runs as a non-root user.
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$APP_DIR/.keys"
  ln -sf "$KEYS_DIR/bidder1.json" "$APP_DIR/.keys/bidder1.json"
  ln -sf "$KEYS_DIR/bidder2.json" "$APP_DIR/.keys/bidder2.json"
  ln -sf "$KEYS_DIR/seller.json"  "$APP_DIR/.keys/seller.json"
fi

# Background processes — captured PIDs so we can kill them on signal.
PIDS=()

# Compose every command line into a variable first so `SEALDEX_DRY_RUN=1`
# can print without exec-ing. Fork helper centralises the dry-run gate.
LAUNCHED_CMDS=()
fork_or_print() {
  local label="$1"; shift
  local cmd_str="$*"
  LAUNCHED_CMDS+=("$label :: $cmd_str")
  if [ "$DRY_RUN" = "1" ]; then
    echo "[entrypoint:dry-run] $label :: $cmd_str"
    return
  fi
  echo "[entrypoint] starting $label"
  bash -c "$cmd_str" &
  PIDS+=($!)
}

if [ "$DRY_RUN" != "1" ]; then
  trap 'echo "[entrypoint] shutting down"; kill "${PIDS[@]}" 2>/dev/null || true; wait || true' TERM INT
fi

fork_or_print "frontend" \
  "cd $APP_DIR/frontend && PORT=${PORT:-3000} HOSTNAME=0.0.0.0 yarn next start"

fork_or_print "bidder-alpha" \
  "cd $APP_DIR && node --import tsx agents/bidder/index.ts agents/bidder/configs/alpha.json"

fork_or_print "bidder-beta" \
  "cd $APP_DIR && node --import tsx agents/bidder/index.ts agents/bidder/configs/beta.json"

if [ "$BYOK_ENABLED" = "1" ]; then
  # The BYOK worker reconciles user-spawned bidders. It reads the spawn
  # registry under SEALDEX_STATE_DIR/spawns/, decrypts each spawn's
  # creds blob with the session secret as master, and forks the bidder
  # entry per spawn. tick = 2s by default.
  fork_or_print "spawn-worker" \
    "cd $APP_DIR && SEALDEX_STATE_DIR=$STATE_DIR SEALDEX_SESSION_SECRET=\"$SEALDEX_SESSION_SECRET\" node --import tsx frontend/worker/spawn-worker.ts"
else
  echo "[entrypoint] BYOK disabled (SEALDEX_BYOK=0) — skipping spawn-worker"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[entrypoint:dry-run] would have launched ${#LAUNCHED_CMDS[@]} processes — exiting cleanly"
  exit 0
fi

# Give frontend + bidders a moment to settle before the first cycle.
sleep 6

# CYCLE_MODE=live skips auto-posting (cycle.sh self-noops). Demo mode posts
# fresh auctions on a timer so judges see live activity even when no human
# is sitting in the seller seat.
echo "[entrypoint] starting cycle loop (CYCLE_MODE=${CYCLE_MODE:-demo})"
"$APP_DIR/cycle.sh" &
PIDS+=($!)

# Wait on whichever exits first; if the frontend dies the container should
# exit so Fly can restart it.
wait -n "${PIDS[@]}"
status=$?
echo "[entrypoint] one process exited with $status — bringing the container down"
kill "${PIDS[@]}" 2>/dev/null || true
exit $status
