#!/usr/bin/env bats
# 1-node.sh once the node runs: status, tunnel, logs, upgrade, down, and the node.env it reads.
load helpers

setup_file() { start_mock; }
teardown_file() { stop_mock; }
setup() { setup_node; }
teardown() { teardown_node; }

@test "status --wait shows the full status, then one line per check with an ETA, then the full status" {
  mock_control '{"blockDelay":[5000,400,3]}'
  run node_sh status --wait
  assert_success
  assert_line --index 0 --partial "synced: no"
  assert_line --regexp '^[0-9]{2}:[0-9]{2}  6m behind, ETA [0-9hms ]+$'
  assert_output --partial "synced: yes"
  [ "$(grep -c '^shard 0 ' <<<"$output")" = 2 ]
}

@test "status --wait says once, not on every check, that the node is still starting" {
  mock_control '{"infoUnavailable":3,"blockDelay":[3]}'
  run node_sh status --wait
  assert_success
  [ "$(grep -c 'still starting' <<<"$output")" = 1 ]
  assert_output --partial "synced: yes"
}

@test "status says why when ssh cannot connect, and status --wait stops after three tries" {
  FAKE_SSH_FAIL_TIMES=999 run node_sh status
  assert_failure 1
  assert_output --partial "no ssh connection to root@203.0.113.50: ssh: connect to host port 22: Connection refused"
  : >"$FAKE_LOG"
  FAKE_SSH_FAIL_TIMES=999 run node_sh status --wait --timeout 5
  assert_failure 1
  assert_output --partial "no ssh connection"
  [ "$(grep -c '^ssh ' "$FAKE_LOG")" = 3 ]
}

@test "status --wait goes on through an ssh failure that passes" {
  FAKE_SSH_FAIL_TIMES=2 run node_sh status --wait
  assert_success
  assert_output --partial "synced: yes"
}

@test "status --wait --timeout 0 gives up on a node that does not catch up" {
  mock_control '{"blockDelay":[5000]}'
  run node_sh status --wait --timeout 0
  assert_failure
  assert_output --partial "not synced"
}

@test "tunnel starts ssh in the background behind a control socket, and tunnel --stop ends it" {
  run node_sh tunnel
  assert_success
  assert_output --partial "tunnel up"
  grep -q -- "^ssh -f -N .*-S $SOCKET .*-o ServerAliveInterval=15 .*-L 3381:127.0.0.1:3381 -L 3383:127.0.0.1:3383 root@203.0.113.50$" "$FAKE_LOG"
  pid=$(cat "$SOCKET")
  kill -0 "$pid"
  run node_sh tunnel
  assert_output --partial "already up"
  [ "$(grep -c '^ssh -f' "$FAKE_LOG")" = 1 ]
  run node_sh tunnel --stop
  assert_success
  assert_output --partial "tunnel stopped"
  [ ! -e "$SOCKET" ]
  run kill -0 "$pid"
  assert_failure
  run node_sh tunnel --stop
  assert_output --partial "no tunnel is running"
}

@test "tunnel takes over a control socket left behind by a tunnel that died" {
  mkdir -p "$HOME/.ssh"
  sleep 0 &
  wait $!
  echo $! >"$SOCKET"
  run node_sh tunnel
  assert_success
  kill -0 "$(cat "$SOCKET")"
  run node_sh tunnel --stop
  assert_output --partial "tunnel stopped"
}

@test "a tunnel that cannot forward a local port fails with ssh's reason" {
  FAKE_SSH_FORWARD_FAIL=1 run node_sh tunnel
  assert_failure
  assert_output --partial "Address already in use"
  [ ! -e "$SOCKET" ]
}

@test "logs, upgrade and down run docker compose on the host" {
  mkdir -p "$REMOTE"
  node_sh logs >/dev/null
  node_sh upgrade >/dev/null
  node_sh down >/dev/null
  grep -q "docker compose logs -f --tail 100 snapchain" "$FAKE_LOG"
  grep -q "docker compose pull" "$FAKE_LOG"
  grep -q "docker compose down" "$FAKE_LOG"
}

@test "a dry run prints the ssh calls and changes nothing on the host" {
  run node_sh up --dry-run
  assert_success
  assert_line --partial "DRY: ssh"
  [ ! -e "$REMOTE" ]
}

@test "a node.env from a provisioning run that stopped half way exits 2 with what to do" {
  sed -i.bak 's/^NODE_IP=.*/NODE_IP=/' "$ENV_FILE"
  run "$ROOT/scripts/1-node.sh" --env "$ENV_FILE" status
  assert_failure 2
  assert_output --partial "0-provision.sh again"
}

@test "a node.env from a dry run exits 2 instead of waiting for a server that does not exist" {
  sed -i.bak 's/^NODE_CREATED_AT=.*/NODE_CREATED_AT=dry-run/' "$ENV_FILE"
  run node_sh up
  assert_failure 2
  assert_output --partial "dry run"
  [ ! -s "$FAKE_LOG" ]
  run node_sh up --dry-run
  assert_success
}

@test "a node.env whose user or host could pass for an ssh option exits 2 before any ssh" {
  sed -i.bak 's/^NODE_USER=.*/NODE_USER=-oProxyCommand=sh/' "$ENV_FILE"
  run node_sh status
  assert_failure 2
  assert_output --partial "NODE_USER"
  sed -i.bak 's/^NODE_USER=.*/NODE_USER=root/; s/^NODE_IP=.*/NODE_IP=203.0.113.50;id/' "$ENV_FILE"
  run node_sh status
  assert_failure 2
  assert_output --partial "NODE_IP"
  [ ! -s "$FAKE_LOG" ]
}

@test "a missing node.env exits 2" {
  run "$ROOT/scripts/1-node.sh" --env "$BATS_TEST_TMPDIR/nope.env" status
  assert_failure 2
}
