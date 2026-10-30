#!/usr/bin/env bash
# Smoke test for the hub image and docker-compose.yml.
#
# Builds the image, starts it with compose under a unique project name, and checks that:
#   - GET /.well-known/oauth-authorization-server answers 200,
#   - the SQLite database appears in the bind-mounted data directory,
#   - the hub runs as uid 10001 and the image's HEALTHCHECK reports healthy.
# With AGENT_BIN=<path to a hoistline-agent binary for this host>, it also pairs that binary with the hub (using a
# pairing code created directly in the hub's database) and checks that `run` connects.
#
# Everything it creates (containers, network, volumes, image tag, temp dir) is removed on exit.
# KEEP_IMAGE=1 keeps the image tag.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="hoistline-smoke-$$-$RANDOM"
IMAGE="hoistline-hub:$PROJECT"
TMP="$ROOT/.smoke/$PROJECT"
AGENT_PID=""

compose() {
  docker compose --project-name "$PROJECT" --env-file "$TMP/smoke.env" -f "$ROOT/docker-compose.yml" "$@"
}

cleanup() {
  local status=$?
  if [ -n "$AGENT_PID" ]; then kill "$AGENT_PID" 2>/dev/null || true; wait "$AGENT_PID" 2>/dev/null || true; fi
  if [ -f "$TMP/smoke.env" ]; then
    if [ "$status" -ne 0 ]; then compose logs --no-color hub 2>/dev/null | tail -40 || true; fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
  rmdir "$ROOT/.smoke" 2>/dev/null || true
  if [ "$status" -eq 0 ]; then echo "smoke: PASS"; else echo "smoke: FAIL" >&2; fi
}
trap cleanup EXIT
# bash skips the EXIT trap when killed by a signal it doesn't trap; exit instead so cleanup runs.
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT

fail() {
  echo "smoke: $*" >&2
  exit 1
}

mkdir -p "$TMP/data"
# The hub runs as uid 10001; let it write the bind mount whatever the host's uid mapping.
chmod 0777 "$TMP/data"

# Dummy values only: nothing here reaches GitHub (no one logs in).
cat >"$TMP/smoke.env" <<EOF
HUB_IMAGE=$IMAGE
HUB_DATA_DIR=$TMP/data
HUB_PORT=0
PUBLIC_URL=http://127.0.0.1:3000
GITHUB_CLIENT_ID=smoke-client-id
GITHUB_CLIENT_SECRET=smoke-client-secret
EOF

echo "smoke: building $IMAGE"
compose build hub
echo "smoke: starting project $PROJECT"
compose up -d hub

PORT="$(compose port hub 3000 | sed 's/.*://')"
[ -n "$PORT" ] || fail "no published port for the hub"
BASE="http://127.0.0.1:$PORT"

code=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-authorization-server" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || fail "GET /.well-known/oauth-authorization-server returned ${code:-nothing}, expected 200"
echo "smoke: GET /.well-known/oauth-authorization-server -> 200"

[ -f "$TMP/data/hoistline.db" ] || fail "no SQLite database at $TMP/data/hoistline.db"
echo "smoke: database file present in the data dir"

uid="$(compose exec -T hub id -u | tr -d '\r')"
[ "$uid" = "10001" ] || fail "the hub runs as uid $uid, expected 10001"
echo "smoke: hub runs as uid 10001"

health=""
for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q hub)")"
  [ "$health" = "healthy" ] && break
  sleep 1
done
[ "$health" = "healthy" ] || fail "container health is ${health:-unknown}, expected healthy"
echo "smoke: container healthy"

if [ -n "${AGENT_BIN:-}" ]; then
  export HOISTLINE_AGENT_HOME="$TMP/agent-home"
  pair_code="$(compose exec -T hub node --input-type=module -e "
    import { Store } from '/app/dist/index.js';
    const store = new Store(process.env.DATABASE_PATH);
    const user = store.upsertUser({ provider: 'github', subject: 'smoke', login: 'smoke' });
    process.stdout.write(store.createPairingCode(user.id));
    store.close();
  " | tr -d '\r')"
  [ -n "$pair_code" ] || fail "could not create a pairing code"
  "$AGENT_BIN" pair "$BASE" "$pair_code" --name smoke-agent || fail "agent pairing failed"
  "$AGENT_BIN" run >"$TMP/agent.log" 2>&1 &
  AGENT_PID=$!
  for _ in $(seq 1 30); do
    grep -q "connected to the hub" "$TMP/agent.log" && break
    sleep 1
  done
  grep -q "connected to the hub" "$TMP/agent.log" || { cat "$TMP/agent.log" >&2; fail "the agent did not connect"; }
  echo "smoke: agent binary paired and connected"
fi
