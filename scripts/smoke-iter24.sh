#!/usr/bin/env bash
# E2E smoke for iteration 24 — production entrypoint wiring.
#
# Asserts:
#   1. Bash syntax of entrypoint.sh is valid.
#   2. SEALDEX_DRY_RUN=1 path runs cleanly.
#   3. Dry-run output names: frontend, bidder-alpha, bidder-beta, spawn-worker.
#   4. Refusing to start when SEALDEX_SESSION_SECRET is missing AND BYOK on.
#   5. SEALDEX_BYOK=0 disables the spawn-worker without requiring a secret.
#   6. Worker source files exist where the entrypoint will look for them.
#   7. The Dockerfile copies frontend/lib + frontend/worker (so the
#      runtime image actually has the source).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/scripts/entrypoint.sh"
DOCKERFILE="$REPO_ROOT/Dockerfile"

PASS=0
FAIL=0

check() {
  local name="$1"; shift
  if "$@"; then
    echo "✓ $name"
    PASS=$((PASS + 1))
  else
    echo "✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

# 1. Bash syntax.
check "entrypoint.sh has valid bash syntax" \
  bash -n "$ENTRYPOINT"

# 2 + 3. Dry-run with all required env produces the expected lines.
TMP_DATA=$(mktemp -d)
trap 'rm -rf "$TMP_DATA"' EXIT

DRY_OUT=$(
  SEALDEX_DRY_RUN=1 \
  SEALDEX_APP_DIR="$TMP_DATA/app" \
  DATA_DIR="$TMP_DATA" \
  ANTHROPIC_API_KEY="sk-ant-fake-for-test" \
  SEALDEX_SESSION_SECRET="dummy-secret-32-chars-padding-padding" \
  SELLER_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  BIDDER1_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  BIDDER2_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  bash "$ENTRYPOINT" 2>&1 || true
)

check_grep() {
  local name="$1"; local pattern="$2"
  if grep -q "$pattern" <<<"$DRY_OUT"; then
    echo "✓ $name"
    PASS=$((PASS + 1))
  else
    echo "✗ $name (output:)"
    echo "$DRY_OUT" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
  fi
}

check_grep "dry-run logs the frontend launch"     "dry-run.* frontend ::"
check_grep "dry-run logs bidder-alpha"             "dry-run.* bidder-alpha ::"
check_grep "dry-run logs bidder-beta"              "dry-run.* bidder-beta ::"
check_grep "dry-run logs spawn-worker"             "dry-run.* spawn-worker ::"
check_grep "dry-run mentions worker entry path"    "frontend/worker/spawn-worker.ts"
check_grep "dry-run threads SEALDEX_STATE_DIR"     "SEALDEX_STATE_DIR=.*state"
check_grep "dry-run threads SEALDEX_SESSION_SECRET" "SEALDEX_SESSION_SECRET="
check_grep "dry-run exits cleanly"                  "exiting cleanly"

# 4. BYOK on but secret missing → exit 1.
NO_SECRET_OUT=$(
  SEALDEX_DRY_RUN=1 \
  SEALDEX_APP_DIR="$(mktemp -d)/app" \
  DATA_DIR=$(mktemp -d) \
  ANTHROPIC_API_KEY="sk-ant-fake" \
  SELLER_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  BIDDER1_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  BIDDER2_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  bash "$ENTRYPOINT" 2>&1
) || EXIT=$?
EXIT=${EXIT:-0}
if [ "$EXIT" -ne 0 ] && grep -q "SEALDEX_SESSION_SECRET" <<<"$NO_SECRET_OUT"; then
  echo "✓ missing SEALDEX_SESSION_SECRET refused (exit=$EXIT)"
  PASS=$((PASS + 1))
else
  echo "✗ missing SEALDEX_SESSION_SECRET should refuse but got exit=$EXIT"
  echo "$NO_SECRET_OUT" | sed 's/^/    /'
  FAIL=$((FAIL + 1))
fi
unset EXIT

# 5. SEALDEX_BYOK=0 disables the worker without requiring a secret.
BYOK_OFF_OUT=$(
  SEALDEX_DRY_RUN=1 \
  SEALDEX_BYOK=0 \
  SEALDEX_APP_DIR="$(mktemp -d)/app" \
  DATA_DIR=$(mktemp -d) \
  ANTHROPIC_API_KEY="sk-ant-fake" \
  SELLER_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  BIDDER1_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  BIDDER2_KEYPAIR_B64="$(printf '[1,2,3]' | base64 -w0)" \
  bash "$ENTRYPOINT" 2>&1 || true
)
if grep -q "BYOK disabled" <<<"$BYOK_OFF_OUT" \
  && ! grep -q "spawn-worker ::" <<<"$BYOK_OFF_OUT"; then
  echo "✓ SEALDEX_BYOK=0 skips spawn-worker without needing the secret"
  PASS=$((PASS + 1))
else
  echo "✗ SEALDEX_BYOK=0 path is broken"
  echo "$BYOK_OFF_OUT" | sed 's/^/    /'
  FAIL=$((FAIL + 1))
fi

# 6. Worker source actually exists where entrypoint will look.
check "frontend/worker/spawn-worker.ts exists" \
  test -f "$REPO_ROOT/frontend/worker/spawn-worker.ts"
check "frontend/lib/cred-crypto.ts exists" \
  test -f "$REPO_ROOT/frontend/lib/cred-crypto.ts"
check "frontend/lib/auth-env.ts exists" \
  test -f "$REPO_ROOT/frontend/lib/auth-env.ts"
check "frontend/lib/spawn-process.ts exists" \
  test -f "$REPO_ROOT/frontend/lib/spawn-process.ts"
check "frontend/lib/spawn-store.ts exists" \
  test -f "$REPO_ROOT/frontend/lib/spawn-store.ts"

# 7. Dockerfile copies the right things into the runtime image.
check "Dockerfile copies frontend/worker" \
  grep -q "/app/frontend/worker" "$DOCKERFILE"
check "Dockerfile copies frontend/lib" \
  grep -q "/app/frontend/lib" "$DOCKERFILE"

echo ""
echo "iter24 entrypoint smoke: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "✓ iter24 entrypoint wiring smoke PASSED"
