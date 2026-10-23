#!/usr/bin/env bash
# The client end to end without a node, a cloud account or a seed phrase of yours: a mock
# Snapchain node on a free local port, a throwaway config directory and the BIP-39 test phrase.
# Nothing leaves this machine. Run `pnpm install` first. With --web it casts once, then serves
# casty web on a free local port until Ctrl-C.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
MOCK_PID=""
trap '[ -z "$MOCK_PID" ] || kill "$MOCK_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

node "$ROOT/test/mock-node/bin/mock-snapchain.mjs" serve --port 0 >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!
url=""
for _ in $(seq 100); do
  url=$(sed -n 's/^mock-snapchain listening on \([^ ]*\).*/\1/p' "$TMP/mock.log")
  [ -z "$url" ] || break
  sleep 0.1
done
[ -n "$url" ] || { cat "$TMP/mock.log" >&2 && exit 1; }

# CASTY_PASSPHRASE exists for tests and demos; casty asks on the terminal otherwise.
export XDG_CONFIG_HOME="$TMP/config" XDG_CACHE_HOME="$TMP/cache" CASTY_PASSPHRASE=demo
casty() {
  local arg line='$ casty'
  for arg in "$@"; do
    case $arg in *" "*) line="$line \"$arg\"" ;; *) line="$line $arg" ;; esac
  done
  printf '\n%s\n' "$line"
  "$ROOT/node_modules/.bin/tsx" "$ROOT/client/src/cli/index.ts" --node "$url" "$@"
}

echo "mock node at $url, config in $XDG_CONFIG_HOME"
casty doctor
echo "test test test test test test test test test test test junk" | casty init --mnemonic-stdin
if [ "${1:-}" = --web ]; then
  casty cast "hello from casty"
  casty web --listen 127.0.0.1:0
  exit 0
fi
casty feed --limit 5
casty feed --limit 5 --exclude-app app-beta
casty cast "hello from casty"
casty feed --limit 3
casty like 2
casty clients
