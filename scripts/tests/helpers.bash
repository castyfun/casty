# shellcheck shell=bash
# Shared setup for the bats suites: fake CLIs first on PATH, a call log, a sandboxed "remote" home.
bats_require_minimum_version 1.5.0
# A test that hangs fails after a minute instead of blocking `make bats`. Bats arms the timer
# before setup() runs, so it is set here, as each suite loads this file. Bats 1.13 leaves the
# timer of a failed test running, which delays the end of a failing suite by up to a minute;
# BATS_TEST_TIMEOUT= (empty) turns it off.
BATS_TEST_TIMEOUT=${BATS_TEST_TIMEOUT-60}
ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
load "$ROOT/node_modules/bats-support/load"
load "$ROOT/node_modules/bats-assert/load"

# shellcheck disable=SC2034 # used by the suites that load this file
PUBKEY="$ROOT/scripts/tests/fixtures/id_ed25519.pub"

setup_fakes() {
  # A home of its own, so ~/.ssh (control sockets, known hosts) is never the real one.
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  export PATH="$ROOT/test/fakebin:$PATH"
  export FAKE_LOG="$BATS_TEST_TMPDIR/calls.log"
  export FAKE_REMOTE_HOME="$BATS_TEST_TMPDIR/remote"
  mkdir -p "$FAKE_REMOTE_HOME"
  : >"$FAKE_LOG"
  unset HCLOUD_TOKEN AWS_ACCESS_KEY_ID AWS_PROFILE AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE CHERRY_AUTH_TOKEN FAKE_HCLOUD_EXISTING FAKE_AWS_EXISTING
}

# Replaces machine-specific paths so output can be compared with a golden file: the test's
# directory, the checkout, and a script's own mktemp -d directory, wherever the OS puts it.
normalize() {
  sed -e "s#$BATS_TEST_TMPDIR#TMP#g" -e "s#$ROOT#ROOT#g" -e 's#[^ <]*/tmp\.[A-Za-z0-9]\{6,\}/#TMPDIR/#g'
}

# assert_golden <name>: $output equals scripts/tests/golden/<name>.txt (UPDATE_GOLDEN=1 rewrites it).
# shellcheck disable=SC2154 # bats' `run` sets $output
assert_golden() {
  local golden="$ROOT/scripts/tests/golden/$1.txt"
  if [ "${UPDATE_GOLDEN:-0}" = 1 ]; then printf '%s\n' "$output" | normalize >"$golden"; fi
  diff -u "$golden" <(printf '%s\n' "$output" | normalize)
}

# Starts the mock node on a free port and exports NODE_API. Call from setup_file.
start_mock() {
  local log="$BATS_FILE_TMPDIR/mock.log"
  node "$ROOT/test/mock-node/bin/mock-snapchain.mjs" serve --port 0 >"$log" 2>&1 &
  echo $! >"$BATS_FILE_TMPDIR/mock.pid"
  for _ in $(seq 100); do
    grep -q "listening on" "$log" 2>/dev/null && break
    sleep 0.1
  done
  NODE_API=$(sed -n 's/.*listening on \(http[^ ]*\).*/\1/p' "$log")
  [ -n "$NODE_API" ] || { cat "$log" >&2; return 1; }
  export NODE_API
}

stop_mock() {
  kill "$(cat "$BATS_FILE_TMPDIR/mock.pid")" 2>/dev/null || true
}

# mock_control <json>: POST to the mock's control endpoint.
mock_control() {
  curl -fsS -X POST "$NODE_API/__mock/control" -d "$1" >/dev/null
}

# The 1-node suites: a node.env for a Hetzner node, the preflight pinned, the mock synced but 3 s
# behind. The fake ssh takes %C literally, so the tunnel's control socket is $SOCKET.
setup_node() {
  setup_fakes
  touch "$BATS_TEST_TMPDIR/id_ed25519"
  ENV_FILE="$BATS_TEST_TMPDIR/node.env"
  cat >"$ENV_FILE" <<ENV
NODE_PROVIDER=hetzner
NODE_NAME=fc-node
NODE_IP=203.0.113.50
NODE_USER=root
NODE_SSH_KEY=$BATS_TEST_TMPDIR/id_ed25519
NODE_SERVER_ID=4242
NODE_VOLUME_ID=777
NODE_DATA_DIR=/data
NODE_CREATED_AT=2026-10-18T00:00:00Z
ENV
  # The fake ssh runs "remote" commands here, so the preflight measures this machine: pin it.
  export PREFLIGHT_MEM_KB=16777216 PREFLIGHT_FREE_KB=2147483648 POLL_MIN=0 POLL_MAX=0
  mock_control '{"blockDelay":[3]}'
  # shellcheck disable=SC2034 # used by the suites
  REMOTE="$FAKE_REMOTE_HOME/snapchain"
  SOCKET="$HOME/.ssh/casty-tunnel-%C"
}

teardown_node() {
  [ -f "$SOCKET" ] && kill "$(cat "$SOCKET")" 2>/dev/null
  return 0
}

node_sh() { "$ROOT/scripts/1-node.sh" --env "$ENV_FILE" "$@" </dev/null; }
