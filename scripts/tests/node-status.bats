#!/usr/bin/env bats
load helpers

status() { "$ROOT/scripts/lib/node-status.sh" --file "$ROOT/scripts/tests/fixtures/$1"; }

@test "summarises a saved /v1/info, one line per shard in shard order" {
  run status info-synced.json
  assert_success
  assert_line --index 0 --partial "snapchain 0.14.2"
  assert_line --index 1 --regexp '^shard 0 +height 47583086 +behind 1s +size 35.4 GiB +mempool 0$'
  assert_line --index 2 --partial "shard 1"
  assert_line --index 3 --partial "shard 2"
  assert_output --partial "synced: yes"
}

@test "shows the u32::MAX mempool of a read node as n/a" {
  run status info-synced.json
  assert_line --index 2 --partial "mempool n/a"
}

@test "exits 1 while a shard is more than 10 seconds behind" {
  run status info-behind.json
  assert_failure 1
  assert_output --partial "synced: no"
  assert_output --partial "behind 5400s"
}

@test "reports a shard missing from /v1/info instead of failing to parse" {
  run status info-missing-shard.json
  assert_failure 1
  assert_line --partial "shard 2  missing from /v1/info"
}

@test "says what is wrong with output that is not JSON" {
  printf 'not json' >"$BATS_TEST_TMPDIR/bad.json"
  run "$ROOT/scripts/lib/node-status.sh" --file "$BATS_TEST_TMPDIR/bad.json"
  assert_failure
  assert_output --partial "did not return JSON"
}
