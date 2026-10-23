#!/usr/bin/env bats
load helpers

@test "demo runs the client end to end against a mock node, then removes its config" {
  run "$ROOT/scripts/demo.sh"
  assert_success
  assert_output --partial '$ casty cast "hello from casty"'
  assert_output --regexp 'liked [0-9]+:0x[0-9a-f]{40}'
  assert_output --partial "@casty-test"
  [ "$(grep -c 'hello from casty' <<<"$output")" -ge 2 ]
  config=$(sed -n 's/.*, config in //p' <<<"$output")
  [ -n "$config" ] && [ ! -e "$config" ]
}

@test "demo --web serves the page with the test key until interrupted, then cleans up" {
  log="$BATS_TEST_TMPDIR/web.log"
  "$ROOT/scripts/demo.sh" --web >"$log" 2>&1 &
  pid=$!
  link=""
  for _ in $(seq 150); do
    link=$(grep -o 'http://127\.0\.0\.1:[0-9]*/#token=[A-Za-z0-9_-]*' "$log" || true)
    [ -z "$link" ] || break
    sleep 0.1
  done
  [ -n "$link" ] || { cat "$log"; false; }
  run curl -s -H "authorization: Bearer ${link#*#token=}" "${link%%/#*}/api/session"
  assert_output --partial '"canWrite":true'
  pkill -INT -P "$pid" -f "client/src/cli/index.ts" || true
  wait "$pid"
  config=$(sed -n 's/.*, config in //p' "$log")
  [ -n "$config" ] && [ ! -e "$config" ]
}
