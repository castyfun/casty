#!/usr/bin/env bats
# One file for the laptop: the client, its dependencies and the web page, built with bun. The
# suite needs bun; without it every test is skipped.
load helpers

setup_file() {
  command -v bun >/dev/null 2>&1 || return 0
  pnpm --dir "$ROOT" --filter @casty/client build:binary >/dev/null
  start_mock
}
teardown_file() { [ -z "${NODE_API:-}" ] || stop_mock; }

setup() {
  command -v bun >/dev/null 2>&1 || skip "bun is not installed"
  BINARY="$ROOT/client/release/casty"
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config" CASTY_PASSPHRASE=x
}

@test "build:binary writes one file that runs without Node, under 80 MB on macOS" {
  [ -x "$BINARY" ]
  size=$(wc -c <"$BINARY")
  # bun's own runtime is 71 MB on macOS and 90 MB on Linux; 80 MB holds on macOS.
  if [ "$(uname -s)" = Darwin ]; then [ "$size" -le 83886080 ]; else [ "$size" -le 104857600 ]; fi
  run env -i PATH=/usr/bin:/bin HOME="$HOME" "$BINARY" --help
  assert_success
  assert_output --partial "Usage: casty"
  # The release workflow runs the build script from the repository's root.
  run bash -c "cd '$BATS_TEST_TMPDIR' && node '$ROOT/client/binary.mjs'"
  assert_success
  assert_output --partial "release/casty:"
}

@test "the binary runs doctor, init, feed and cast against the mock" {
  run "$BINARY" doctor --node "$NODE_API" --json
  assert_success
  [ "$(jq .synced <<<"$output")" = true ]
  printf 'test test test test test test test test test test test junk\n' |
    "$BINARY" init --mnemonic-stdin --node "$NODE_API" --json >"$BATS_TEST_TMPDIR/init.json"
  [ "$(jq .fid "$BATS_TEST_TMPDIR/init.json")" = 2000000001 ]
  run "$BINARY" feed --node "$NODE_API" --limit 20
  assert_success
  assert_line --index 0 --regexp '^ *1  @'
  run "$BINARY" cast "hello from the binary" --node "$NODE_API" --json
  assert_success
  [[ $(jq -r .hash <<<"$output") == 0x* ]]
}

@test "the binary serves the web page from the files embedded in it" {
  printf 'test test test test test test test test test test test junk\n' |
    "$BINARY" init --mnemonic-stdin --node "$NODE_API" >/dev/null 2>&1
  log="$BATS_TEST_TMPDIR/web.log"
  "$BINARY" web --node "$NODE_API" --listen 127.0.0.1:0 --read-only >"$log" 2>&1 &
  pid=$!
  url=""
  for _ in $(seq 100); do
    url=$(sed -n 's/^casty web on \(http[^ ]*\).*/\1/p' "$log")
    [ -z "$url" ] || break
    sleep 0.1
  done
  [ -n "$url" ] || { kill "$pid"; cat "$log" >&2; false; }
  page=$(curl -fsS "$url/")
  run curl -fsS -o /dev/null -w '%{http_code} %{content_type}' "$url/app.js"
  kill "$pid"
  assert_output "200 text/javascript; charset=utf-8"
  [[ $page == *"<title>casty</title>"* ]]
}

@test "--help answers in under 60 ms" {
  # make check runs its targets side by side, and a shared runner is never idle: measured on request.
  [ -n "${CASTY_TIMING:-}" ] || skip "set CASTY_TIMING=1 on an idle machine to measure"
  run node -e '
    const { execFileSync } = require("node:child_process");
    const times = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      execFileSync(process.argv[1], ["--help"]);
      times.push(performance.now() - started);
    }
    console.log(Math.round(Math.min(...times)));
  ' "$BINARY"
  assert_success
  [ "$output" -lt 60 ]
}

@test "build:binary writes THIRD_PARTY_LICENSES next to the binary: every package inside it, with its license" {
  notices="$ROOT/client/release/THIRD_PARTY_LICENSES"
  [ -f "$notices" ]
  for package in viem @noble/ciphers commander uqr; do
    grep -Eq "^$package [0-9., ]+ \(MIT\)$" "$notices"
  done
  grep -q "Permission is hereby granted" "$notices"
  # A package that ships no license file is still named, with what its package.json says.
  grep -Eq "^@farcaster/core [0-9.]+ \(MIT\)$" "$notices"
  grep -A3 "^@farcaster/core " "$notices" | grep -q "no license file"
}
