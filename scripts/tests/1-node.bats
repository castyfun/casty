#!/usr/bin/env bats
# 1-node.sh up: what it installs on the host and how it gets there.
load helpers

setup_file() { start_mock; }
teardown_file() { stop_mock; }
setup() { setup_node; }
teardown() { teardown_node; }

@test "up writes ~/snapchain/.env without overwriting keys that are already there" {
  mkdir -p "$REMOTE"
  printf 'HUB_OPERATOR_FID=2000000099\nGRAFANA_CREDS=me:mine\n' >"$REMOTE/.env"
  run node_sh up --fid 2000000005
  assert_success
  grep -qx "HUB_OPERATOR_FID=2000000099" "$REMOTE/.env"
  grep -qx "GRAFANA_CREDS=me:mine" "$REMOTE/.env"
  grep -qx "AGREE_NO_REWARDS_FOR_ME=true" "$REMOTE/.env"
  grep -qx "SKIP_CRONTAB=true" "$REMOTE/.env"
  [ "$(grep -c '^HUB_OPERATOR_FID=' "$REMOTE/.env")" = 1 ]
}

@test "up on a fresh host records the operator fid and one random Grafana password, for snapchain.sh and for Grafana" {
  run node_sh up --fid 2000000005
  assert_success
  grep -qx "HUB_OPERATOR_FID=2000000005" "$REMOTE/.env"
  password=$(sed -n 's/^GRAFANA_PASSWORD=//p' "$REMOTE/.env")
  [[ $password =~ ^[A-Za-z0-9]{16}$ ]]
  grep -qx "GRAFANA_CREDS=admin:$password" "$REMOTE/.env"
}

@test "up adds its keys on lines of their own to a .env that does not end in a newline" {
  mkdir -p "$REMOTE"
  printf 'HUB_OPERATOR_FID=2000000099' >"$REMOTE/.env"
  run node_sh up
  assert_success
  grep -qx "HUB_OPERATOR_FID=2000000099" "$REMOTE/.env"
  grep -qx "AGREE_NO_REWARDS_FOR_ME=true" "$REMOTE/.env"
}

@test "up logs in afresh after cloud-init, so the commands that follow have its docker group" {
  run node_sh up
  assert_success
  waited=$(grep -n 'cloud-init status --wait' "$FAKE_LOG" | head -1 | cut -d: -f1)
  closed=$(grep -n -- "-O exit .*@" "$FAKE_LOG" | grep -v tunnel | head -1 | cut -d: -f1)
  checked=$(grep -n 'bash -s' "$FAKE_LOG" | head -1 | cut -d: -f1)
  [ -n "$closed" ] && [ "$waited" -lt "$closed" ] && [ "$closed" -lt "$checked" ]
}

@test "up fetches the compose file and validators.toml from the @latest tag" {
  run node_sh up
  assert_success
  grep -q "https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/docker-compose.mainnet.yml" "$FAKE_LOG"
  grep -q "https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/validators.toml" "$FAKE_LOG"
  [ -f "$REMOTE/docker-compose.yml" ]
  [ -f "$REMOTE/validators.toml" ]
}

@test "--release fetches that release's files and pins the node image to it" {
  run node_sh up --release 0.14.3
  assert_success
  grep -q "https://raw.githubusercontent.com/farcasterxyz/snapchain/v0.14.3/docker-compose.mainnet.yml" "$FAKE_LOG"
  grep -q "https://raw.githubusercontent.com/farcasterxyz/snapchain/v0.14.3/validators.toml" "$FAKE_LOG"
  [ "$(yq '.services.snapchain.image' "$REMOTE/docker-compose.yml")" = farcasterxyz/snapchain:0.14.3 ]
}

@test "upgrade --release moves a pinned node to another release; upgrade alone unpins it" {
  mkdir -p "$REMOTE"
  run node_sh upgrade --release 0.14.3
  assert_success
  [ "$(yq '.services.snapchain.image' "$REMOTE/docker-compose.yml")" = farcasterxyz/snapchain:0.14.3 ]
  run node_sh upgrade
  assert_success
  [ "$(yq '.services.snapchain.image' "$REMOTE/docker-compose.yml")" = farcasterxyz/snapchain:latest ]
}

@test "--release fails, saying why, when the release's compose file does not name the node image" {
  FAKE_CURL_NO_IMAGE=1 run node_sh up --release 0.14.3
  assert_failure 4
  assert_output --partial "does not name farcasterxyz/snapchain:latest"
  run grep "docker compose up" "$FAKE_LOG"
  assert_failure
}

@test "--release removes an earlier weekly auto-upgrade, which would replace the pinned release" {
  mkdir -p "$REMOTE"
  export FAKE_CRONTAB="0 3 * * 2 \$HOME/snapchain/snapchain.sh autoupgrade
0 4 * * * backup"
  run node_sh upgrade --release 0.14.3
  assert_success
  assert_output --partial "auto-upgrade"
  grep -qx "crontab> 0 4 \* \* \* backup" "$FAKE_LOG"
  run grep "crontab> .*autoupgrade" "$FAKE_LOG"
  assert_failure
  [ "$(grep -c '^ssh .*crontab' "$FAKE_LOG")" = 1 ]
}

@test "--release takes a version such as 0.14.3, and not with --autoupgrade" {
  run node_sh up --release latest
  assert_failure 2
  run node_sh up --release 0.14.3 --fid 2000000005 --autoupgrade
  assert_failure 2
  assert_output --partial "--autoupgrade"
}

@test "the override binds Grafana to loopback and leaves the node alone by default" {
  run node_sh up
  assert_success
  [ "$(yq '.services.grafana.ports[0]' "$REMOTE/docker-compose.override.yml")" = "127.0.0.1:3000:3000" ]
  [ "$(yq '.services | keys | join(",")' "$REMOTE/docker-compose.override.yml")" = grafana ]
}

@test "--block-retention sets SNAPCHAIN_PRUNING__BLOCK_RETENTION in the override" {
  run node_sh up --block-retention 14
  assert_success
  [ "$(yq '.services.snapchain.environment.SNAPCHAIN_PRUNING__BLOCK_RETENTION' "$REMOTE/docker-compose.override.yml")" = 14d ]
}

@test "up starts the snapchain and statsd services and waits for sync" {
  run node_sh up
  assert_success
  grep -q "docker compose up -d snapchain statsd" "$FAKE_LOG"
  assert_output --partial "synced: yes"
}

@test "up says the long wait can be left and picked up again with status --wait, not another up" {
  run node_sh up --release 0.14.3
  assert_success
  assert_output --partial "Ctrl-C"
  assert_output --partial "1-node.sh --env $ENV_FILE status --wait picks up"
  assert_output --partial "1-node.sh --env $ENV_FILE tunnel"
}

@test "up stops at once with exit 3 when the private key in node.env is not there" {
  sed -i.bak "s|^NODE_SSH_KEY=.*|NODE_SSH_KEY=$BATS_TEST_TMPDIR/gone|" "$ENV_FILE"
  run node_sh up
  assert_failure 3
  assert_output --partial "$BATS_TEST_TMPDIR/gone"
  [ ! -s "$FAKE_LOG" ]
}

@test "with no command, ends with the tunnel up and the next step" {
  run node_sh
  assert_success
  assert_line "next: $ROOT/scripts/2-client.sh"
}

@test "up never prompts, even with stdin closed" {
  run bash -c "'$ROOT/scripts/1-node.sh' --env '$ENV_FILE' up 0<&-"
  assert_success
}

@test "stops with exit 3 before any ssh when jq, which reads the node's status, is missing" {
  # A PATH of links to everything on this PATH but jq, the fakes first.
  local nojq="$BATS_TEST_TMPDIR/nojq" dir tool name dirs
  mkdir -p "$nojq"
  IFS=: read -ra dirs <<<"$PATH"
  for dir in "${dirs[@]}"; do
    for tool in "$dir"/*; do
      name=${tool##*/}
      [ -x "$tool" ] && [ "$name" != jq ] && [ ! -L "$nojq/$name" ] || continue
      ln -s "$tool" "$nojq/$name"
    done
  done
  PATH="$nojq" run node_sh up
  assert_failure 3
  assert_output --partial "jq is not installed"
  [ ! -s "$FAKE_LOG" ]
}

@test "a node made more than 15 minutes ago gets a few ssh tries, not twenty minutes of them" {
  SSH_RETRY_SLEEP=0 FAKE_SSH_FAIL_TIMES=999 run node_sh up
  assert_failure 4
  [ "$(grep -c '^ssh ' "$FAKE_LOG")" = 6 ]
}

@test "a node made in the last 15 minutes gets up to 60 ssh tries while it boots" {
  sed -i.bak "s/^NODE_CREATED_AT=.*/NODE_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)/" "$ENV_FILE"
  SSH_RETRY_SLEEP=0 FAKE_SSH_FAIL_TIMES=999 run node_sh up
  assert_failure 4
  [ "$(grep -c '^ssh ' "$FAKE_LOG")" = 60 ]
}

@test "a node step 0 started again in the last 15 minutes gets up to 60 ssh tries too" {
  printf 'NODE_STARTED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$ENV_FILE"
  SSH_RETRY_SLEEP=0 FAKE_SSH_FAIL_TIMES=999 run node_sh up
  assert_failure 4
  [ "$(grep -c '^ssh ' "$FAKE_LOG")" = 60 ]
}

@test "--help lists the exit codes" {
  run "$ROOT/scripts/1-node.sh" --help
  assert_success
  assert_output --partial "Exit codes: 0 ok, 1 not synced"
}

@test "up waits for ssh on a host that is still booting" {
  SSH_RETRY_SLEEP=0 FAKE_SSH_FAIL_TIMES=3 run node_sh up
  assert_success
  assert_output --partial "waiting for ssh"
}

@test "up stops at once, exit 4, when the host key is not the one known for the node" {
  SSH_RETRY_SLEEP=0 FAKE_SSH_HOST_KEY_CHANGED=1 run node_sh up
  assert_failure 4
  assert_output --partial "host key"
  assert_output --partial "$BATS_TEST_TMPDIR/node.known_hosts"
  [ "$(grep -c '^ssh ' "$FAKE_LOG")" = 1 ]
}

@test "every ssh call offers only the node's key and keeps host keys in a file next to node.env" {
  run node_sh
  assert_success
  calls=$(grep -c '^ssh ' "$FAKE_LOG")
  [ "$calls" -gt 3 ]
  [ "$(grep -c -- "-o IdentitiesOnly=yes -o UserKnownHostsFile=\"$BATS_TEST_TMPDIR/node.known_hosts\" -i " "$FAKE_LOG")" = "$calls" ]
}

@test "the calls of a run share one ssh connection, and the tunnel keeps its own" {
  run node_sh
  assert_success
  remote=$(grep '^ssh ' "$FAKE_LOG" | grep -v -e '^ssh -f ' -e ' -O ' | grep -c .)
  [ "$remote" -gt 3 ]
  [ "$(grep -v ' -O ' "$FAKE_LOG" | grep -c -- "-o ControlMaster=auto -o ControlPersist=120 -o ControlPath=\"$HOME/.ssh/casty-%C\" ")" = "$remote" ]
  run grep -e '^ssh -f .*ControlPersist' -e '^ssh -f .*casty-%C' "$FAKE_LOG"
  assert_failure
}

@test "up gives up with exit 4 when ssh never answers" {
  SSH_RETRY_SLEEP=0 SSH_RETRIES=2 FAKE_SSH_FAIL_TIMES=99 run node_sh up
  assert_failure 4
  assert_output --partial "ssh"
}

@test "up stops with exit 5 when the host fails the preflight" {
  PREFLIGHT_MEM_KB=1000000 run node_sh up
  assert_failure 5
  assert_output --partial "ram"
  run grep "docker compose up" "$FAKE_LOG"
  assert_failure
}

@test "the preflight tells a docker command without a daemon it can reach from no docker" {
  FAKE_DOCKER_NO_SERVER=1 run node_sh up
  assert_failure 5
  assert_output --regexp "docker +no server +installed +no"
}

@test "the preflight gets a data directory with a space as one argument" {
  sed -i.bak 's|^NODE_DATA_DIR=.*|NODE_DATA_DIR=/srv/snap data|' "$ENV_FILE"
  run node_sh up
  assert_success
  assert_output --regexp "clock +[0-9]+ s +<= 60 s +yes"
}

@test "up stops with exit 5 when Docker Compose is older than 2.24.4, which the override needs" {
  FAKE_COMPOSE_VERSION=2.24.3 run node_sh up
  assert_failure 5
  assert_output --regexp "compose +2\.24\.3 +2\.24\.4 or newer +no"
  FAKE_COMPOSE_VERSION=v2.24.4-desktop.1 run node_sh up
  assert_success
}

@test "--autoupgrade installs the weekly snapchain.sh cron entry and leaves SKIP_CRONTAB out" {
  run node_sh up --fid 2000000005 --autoupgrade
  assert_success
  grep -Eq '^crontab> 0 [0-6] \* \* [1-5] .*/snapchain/snapchain.sh autoupgrade' "$FAKE_LOG"
  run grep SKIP_CRONTAB "$REMOTE/.env"
  assert_failure
}

@test "--autoupgrade needs --fid" {
  run node_sh up --autoupgrade
  assert_failure 2
}

@test "up binds statsd to loopback through the compose file's own STATSD_PUBLISH variables" {
  run node_sh up
  assert_success
  grep -qx "STATSD_PUBLISH=127.0.0.1:8125" "$REMOTE/.env"
  grep -qx "STATSD_ADMIN_PUBLISH=127.0.0.1:8126" "$REMOTE/.env"
}

@test "the override gives Grafana the password .env records and its provisioning directory" {
  run node_sh up
  assert_success
  [ "$(yq '.services.grafana.environment.GF_SECURITY_ADMIN_PASSWORD' "$REMOTE/docker-compose.override.yml")" = '${GRAFANA_PASSWORD:-admin}' ]
  [ "$(yq '.services.grafana.volumes[0]' "$REMOTE/docker-compose.override.yml")" = "./grafana/provisioning:/etc/grafana/provisioning" ]
}

@test "up prepares Grafana: its config file, a data directory it can write, the Graphite datasource and the Snapchain dashboard" {
  run node_sh up
  assert_success
  grep -q "curl -fsSL -o grafana/grafana.ini https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/grafana/grafana.ini" "$FAKE_LOG"
  [ -f "$REMOTE/grafana/grafana.ini" ]
  [ "$(ls -ld "$REMOTE/grafana/data" | cut -c2-10)" = rwxrwxrwx ]
  [ -f "$REMOTE/grafana/provisioning/dashboards/snapchain.json" ]
  [ "$(yq '.datasources[0] | .name + " " + .type + " " + .url' "$REMOTE/grafana/provisioning/datasources/graphite.yaml")" = "Graphite graphite http://statsd:80" ]
  [ "$(yq '.providers[0].options.path' "$REMOTE/grafana/provisioning/dashboards/snapchain.yaml")" = /etc/grafana/provisioning/dashboards ]
}
