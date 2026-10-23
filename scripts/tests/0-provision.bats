#!/usr/bin/env bats
load helpers

setup() {
  setup_fakes
  OUT="$BATS_TEST_TMPDIR/node.env"
}

provision() { "$ROOT/scripts/0-provision.sh" --out "$OUT" --ssh-pubkey "$PUBKEY" "$@"; }

@test "hetzner dry run prints the hcloud calls (golden)" {
  run provision --provider hetzner --dry-run
  assert_success
  assert_golden hetzner
}

@test "aws dry run prints the aws calls (golden)" {
  run provision --provider aws --dry-run
  assert_success
  assert_golden aws
}

@test "cherry dry run prints the cherryctl calls (golden)" {
  run provision --provider cherry --dry-run
  assert_success
  assert_golden cherry
}

@test "existing-host dry run prints the preflight call (golden)" {
  run provision --provider existing --host u@127.0.0.1 --dry-run
  assert_success
  assert_golden existing
}

@test "a dry run touches no provider and writes node.env with placeholders" {
  run provision --provider hetzner --dry-run
  assert_success
  [ ! -s "$FAKE_LOG" ]
  for key in NODE_PROVIDER NODE_NAME NODE_IP NODE_USER NODE_SSH_KEY NODE_SERVER_ID NODE_VOLUME_ID NODE_DATA_DIR NODE_CREATED_AT; do
    grep -q "^$key=" "$OUT"
  done
  grep -qx "NODE_DATA_DIR=/data" "$OUT"
  grep -qx "NODE_SERVER_ID=dry-run" "$OUT"
}

@test "a missing HCLOUD_TOKEN exits 3 with a one-line fix" {
  run provision --provider hetzner
  assert_failure 3
  assert_output --partial "HCLOUD_TOKEN"
}

@test "shows what it will create and stops, creating nothing, unless the name is typed back" {
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 </dev/null
  assert_failure 2
  assert_output --partial "fc-node-data, 2000 GB"
  assert_output --partial "from 198.51.100.1/32"
  assert_output --partial "nothing was created"
  run grep " create" "$FAKE_LOG"
  assert_failure
}

@test "creates the resources once the name is typed back" {
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 <<<fc-node
  assert_success
  grep -q "^hcloud server create --name fc-node" "$FAKE_LOG"
}

@test "creates ssh key, firewall, volume and server, then records them in node.env" {
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep -E "^hcloud (ssh-key|firewall|volume|server) create" "$FAKE_LOG"
  assert_line --index 0 --partial "ssh-key create --name fc-node"
  assert_line --index 1 --partial "firewall create --name fc-node-fw"
  assert_line --index 2 --partial "volume create --name fc-node-data --size 2000 --location fsn1 --format ext4"
  assert_line --index 3 --partial "server create --name fc-node --type cpx41 --image ubuntu-24.04"
  grep -qx "NODE_IP=198.51.100.7" "$OUT"
  grep -qx "NODE_SERVER_ID=4242" "$OUT"
  grep -qx "NODE_VOLUME_ID=777" "$OUT"
  grep -qx "NODE_USER=root" "$OUT"
  [ "$(grep -c "^hcloud server describe" "$FAKE_LOG")" = 1 ]
}

@test "opens 22, 3381 and 3383 to --allow-ip only, and gossip on 3382 to everyone" {
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  rules="$BATS_TEST_TMPDIR/fc-node.firewall.json"
  [ "$(jq -r '.[] | select(.port == "22") | .source_ips[]' "$rules")" = 198.51.100.1/32 ]
  [ "$(jq -r '[.[] | select(.port == "3381" or .port == "3383") | .source_ips[]] | unique[]' "$rules")" = 198.51.100.1/32 ]
  [ "$(jq -r '[.[] | select(.port == "3382") | .protocol] | sort | join(",")' "$rules")" = tcp,udp ]
  [ "$(jq -r '[.[] | select(.port == "3382") | .source_ips[]] | unique | join(",")' "$rules")" = "0.0.0.0/0,::/0" ]
}

@test "--allow-ip auto asks api.ipify.org for the caller's address" {
  HCLOUD_TOKEN=x run provision --provider hetzner --yes
  assert_success
  grep -q "^curl -s .*https://api.ipify.org" "$FAKE_LOG"
  grep -q '203.0.113.7/32' "$BATS_TEST_TMPDIR/fc-node.firewall.json"
}

fingerprint() { ssh-keygen -l -E md5 -f "$PUBKEY" | awk '{ print $2 }' | sed 's/^MD5://'; }

@test "a second run with the same --name finds everything and creates nothing" {
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw"
  FAKE_HCLOUD_SSH_KEYS="$(fingerprint) fc-node"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep " create" "$FAKE_LOG"
  assert_failure
  grep -qx "NODE_IP=198.51.100.7" "$OUT"
}

@test "a second run powers on a Hetzner server it finds off" {
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw" FAKE_HCLOUD_SERVER_STATUS=off
  FAKE_HCLOUD_SSH_KEYS="$(fingerprint) fc-node"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  grep -qx "hcloud server poweron fc-node" "$FAKE_LOG"
}

@test "records when it last started the server: on creating it and on powering it on" {
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  grep -Eqx "NODE_STARTED_AT=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z" "$OUT"
  sed -i.bak 's/^NODE_STARTED_AT=.*/NODE_STARTED_AT=2026-10-01T00:00:00Z/' "$OUT"
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw"
  FAKE_HCLOUD_SSH_KEYS="$(fingerprint) fc-node"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  grep -qx "NODE_STARTED_AT=2026-10-01T00:00:00Z" "$OUT"
  FAKE_HCLOUD_SERVER_STATUS=off HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep -x "NODE_STARTED_AT=2026-10-01T00:00:00Z" "$OUT"
  assert_failure
  grep -Eqx "NODE_STARTED_AT=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z" "$OUT"
}

@test "aws: starting a stopped instance records when" {
  FAKE_AWS_KEY_PAIR="$(cut -d' ' -f1,2 "$PUBKEY") fc-node"
  export FAKE_AWS_EXISTING=1 FAKE_AWS_KEY_PAIR FAKE_AWS_INSTANCE_STATE=stopped
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_success
  grep -Eqx "NODE_STARTED_AT=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z" "$OUT"
}

@test "a second run leaves a running Hetzner server alone" {
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw"
  FAKE_HCLOUD_SSH_KEYS="$(fingerprint) fc-node"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep poweron "$FAKE_LOG"
  assert_failure
}

@test "--destroy waits for Hetzner to let go of a volume the deleted server still held" {
  provision --provider hetzner --dry-run >/dev/null
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw" FAKE_HCLOUD_VOLUME_BUSY=2 HCLOUD_RETRY_SLEEP=0
  HCLOUD_TOKEN=x run provision --provider hetzner --destroy --yes
  assert_success
  [ "$(grep -c "^hcloud volume delete fc-node-data" "$FAKE_LOG")" = 3 ]
}

@test "--name may not start with a dash, which a provider CLI would read as a flag" {
  run provision --provider hetzner --name -x --dry-run
  assert_failure 2
  assert_output --partial "--name"
}

@test "--name may not end with a dash, which no host name may" {
  run provision --provider hetzner --name node- --dry-run
  assert_failure 2
}

@test "a second run points the firewall at the caller's current address" {
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw"
  FAKE_HCLOUD_SSH_KEYS="$(fingerprint) fc-node"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.99/32 --yes
  assert_success
  grep -q "^hcloud firewall replace-rules fc-node-fw --rules-file " "$FAKE_LOG"
  grep -q '198.51.100.99/32' "$BATS_TEST_TMPDIR/fc-node.firewall.json"
}

@test "finds an existing resource even in a long list" {
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw" FAKE_HCLOUD_PADDING=20000
  FAKE_HCLOUD_SSH_KEYS="$(fingerprint) fc-node"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep " create" "$FAKE_LOG"
  assert_failure
}

@test "a list that fails is a provider error, not a missing resource" {
  export FAKE_HCLOUD_LIST_FAIL=1
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  run grep " create" "$FAKE_LOG"
  assert_failure
}

@test "a describe that fails is a provider error" {
  export FAKE_HCLOUD_DESCRIBE_FAIL=1
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  assert_output --partial "hcloud volume describe fc-node-data failed"
}

@test "reuses an SSH key Hetzner already has under another name, even one with spaces" {
  FAKE_HCLOUD_SSH_KEYS="00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff work;$(fingerprint) My Laptop"
  export FAKE_HCLOUD_SSH_KEYS
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep "ssh-key create" "$FAKE_LOG"
  assert_failure
  grep -q -- "server create .* --ssh-key My Laptop --firewall " "$FAKE_LOG"
}

@test "stops when another SSH key already has the name it would upload this one under" {
  export FAKE_HCLOUD_SSH_KEYS="00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff fc-node"
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  assert_output --partial "different SSH key named fc-node"
}

@test "falls back to the next server type when one is unavailable" {
  export FAKE_HCLOUD_FAIL_TYPES=cpx41
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  grep -q -- "server create --name fc-node --type ccx23" "$FAKE_LOG"
}

@test "aws reuses resources tagged with the same name" {
  FAKE_AWS_KEY_PAIR="$(cut -d' ' -f1,2 "$PUBKEY") fc-node"
  export FAKE_AWS_EXISTING=1 FAKE_AWS_KEY_PAIR
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep -E "aws ec2 (create|run-instances|import-key-pair|attach-volume)" "$FAKE_LOG"
  assert_failure
  grep -qx "NODE_IP=198.51.100.8" "$OUT"
  grep -qx "NODE_USER=ubuntu" "$OUT"
}

@test "aws opens 22, 3381 and 3383 to --allow-ip only, and gossip on 3382 to everyone, in one call" {
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_success
  rules="$BATS_TEST_TMPDIR/fc-node.firewall.json"
  [ "$(grep -c "authorize-security-group-ingress" "$FAKE_LOG")" = 1 ]
  grep -q -- "authorize-security-group-ingress --group-id sg-0fake0000000000001 --ip-permissions file://$rules " "$FAKE_LOG"
  [ "$(jq -r '.[] | select(.FromPort == 22) | .IpRanges[].CidrIp' "$rules")" = 198.51.100.1/32 ]
  [ "$(jq -r '[.[] | select(.FromPort == 3381 or .FromPort == 3383) | .IpRanges[].CidrIp] | unique[]' "$rules")" = 198.51.100.1/32 ]
  [ "$(jq -r '[.[] | select(.FromPort == 3382) | .IpProtocol] | sort | join(",")' "$rules")" = tcp,udp ]
  [ "$(jq -r '[.[] | select(.FromPort == 3382) | .IpRanges[].CidrIp] | unique | join(",")' "$rules")" = 0.0.0.0/0 ]
  [ "$(jq '[.[] | .FromPort == .ToPort] | all' "$rules")" = true ]
}

@test "aws stops when the region has a different key pair under the node's name" {
  export FAKE_AWS_KEY_PAIR="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKey fc-node"
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  assert_output --partial "different key pair named fc-node"
  run grep -E "aws ec2 (import-key-pair|run-instances)" "$FAKE_LOG"
  assert_failure
}

@test "aws: a second run starts an instance it finds stopped, once it has stopped" {
  FAKE_AWS_KEY_PAIR="$(cut -d' ' -f1,2 "$PUBKEY") fc-node"
  export FAKE_AWS_EXISTING=1 FAKE_AWS_KEY_PAIR FAKE_AWS_INSTANCE_STATE=stopping
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep -n -e "ec2 wait instance-stopped --instance-ids i-0fake0000000000001" \
    -e "ec2 start-instances --instance-ids i-0fake0000000000001" \
    -e "ec2 wait instance-running" "$FAKE_LOG"
  assert_line --index 0 --partial "instance-stopped"
  assert_line --index 1 --partial "start-instances"
  assert_line --index 2 --partial "instance-running"
}

@test "aws: a second run moves the group's rules to the caller's current address" {
  FAKE_AWS_KEY_PAIR="$(cut -d' ' -f1,2 "$PUBKEY") fc-node"
  export FAKE_AWS_EXISTING=1 FAKE_AWS_KEY_PAIR
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.99/32 --yes
  assert_success
  run grep -e "revoke-security-group-ingress --group-id sg-0fake0000000000001" \
    -e "authorize-security-group-ingress --group-id sg-0fake0000000000001" "$FAKE_LOG"
  assert_line --index 0 --partial revoke
  assert_line --index 1 --partial authorize
  grep -q '198.51.100.99/32' "$BATS_TEST_TMPDIR/fc-node.firewall.json"
}

@test "aws: a second run revokes only the rules casty made, by their descriptions" {
  FAKE_AWS_KEY_PAIR="$(cut -d' ' -f1,2 "$PUBKEY") fc-node"
  export FAKE_AWS_EXISTING=1 FAKE_AWS_KEY_PAIR
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.99/32 --yes
  assert_success
  query=$(grep "^aws ec2 describe-security-groups --group-ids" "$FAKE_LOG")
  for description in ssh "snapchain http" "snapchain gossip" "snapchain grpc"; do
    [[ $query == *"\"$description\""* ]]
  done
  [ ! -e "$BATS_TEST_TMPDIR/fc-node.old.firewall.json" ]
}

@test "aws: the plan says a rerun moves casty's rules and leaves the others" {
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_success
  assert_output --partial "others stay"
}

@test "aws: a second run leaves a running instance alone" {
  FAKE_AWS_KEY_PAIR="$(cut -d' ' -f1,2 "$PUBKEY") fc-node"
  export FAKE_AWS_EXISTING=1 FAKE_AWS_KEY_PAIR
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_success
  run grep start-instances "$FAKE_LOG"
  assert_failure
}

@test "aws --destroy also finds by Name tag what a run made but did not get to record" {
  printf 'NODE_PROVIDER=aws\nNODE_NAME=fc-node\nNODE_REGION=us-east-1\nNODE_IP=\nNODE_SERVER_ID=\nNODE_VOLUME_ID=\n' >"$OUT"
  FAKE_AWS_EXISTING=1 AWS_ACCESS_KEY_ID=x run provision --provider aws --destroy --yes
  assert_success
  grep -q "^aws ec2 terminate-instances --instance-ids i-0fake0000000000001 --query" "$FAKE_LOG"
  grep -q "^aws ec2 delete-volume --volume-id vol-0fake0000000000001 " "$FAKE_LOG"
  grep -q "^aws ec2 delete-security-group --group-id sg-0fake0000000000001 " "$FAKE_LOG"
}

@test "aws --destroy deletes an instance and a volume found both in node.env and by tag once" {
  printf 'NODE_PROVIDER=aws\nNODE_NAME=fc-node\nNODE_REGION=us-east-1\nNODE_IP=198.51.100.8\nNODE_SERVER_ID=i-0fake0000000000001\nNODE_VOLUME_ID=vol-0fake0000000000001\n' >"$OUT"
  FAKE_AWS_EXISTING=1 AWS_ACCESS_KEY_ID=x run provision --provider aws --destroy --yes
  assert_success
  grep -q "^aws ec2 terminate-instances --instance-ids i-0fake0000000000001 --query" "$FAKE_LOG"
  [ "$(grep -c "^aws ec2 delete-volume" "$FAKE_LOG")" = 1 ]
}

@test "aws --destroy deletes only what node.env records when it records it, not others of that name" {
  printf 'NODE_PROVIDER=aws\nNODE_NAME=fc-node\nNODE_REGION=us-east-1\nNODE_IP=198.51.100.8\nNODE_SERVER_ID=i-0mine\nNODE_VOLUME_ID=vol-0mine\n' >"$OUT"
  FAKE_AWS_EXISTING=1 AWS_ACCESS_KEY_ID=x run provision --provider aws --destroy --yes
  assert_success
  grep -q "^aws ec2 terminate-instances --instance-ids i-0mine --query" "$FAKE_LOG"
  grep -q "^aws ec2 delete-volume --volume-id vol-0mine " "$FAKE_LOG"
  run grep -e "i-0fake" -e "vol-0fake" "$FAKE_LOG"
  assert_failure
}

@test "a run that stops half way records what it made, and --destroy deletes just that" {
  export FAKE_HCLOUD_FAIL_TYPES="cpx41 ccx23 cpx51"
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  assert_output --partial "add --destroy"
  grep -qx "NODE_NAME=fc-node" "$OUT"
  grep -qx "NODE_IP=" "$OUT"
  : >"$FAKE_LOG"
  FAKE_HCLOUD_EXISTING="fc-node-data fc-node-fw" HCLOUD_TOKEN=x run provision --provider hetzner --destroy --yes
  assert_success
  run grep " delete" "$FAKE_LOG"
  assert_output "$(printf 'hcloud volume delete fc-node-data\nhcloud firewall delete fc-node-fw')"
}

@test "aws: a run that stops half way records the volume, and --destroy deletes it" {
  export FAKE_AWS_NO_CAPACITY=1
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  grep -qx "NODE_VOLUME_ID=vol-0fake0000000000001" "$OUT"
  : >"$FAKE_LOG"
  AWS_ACCESS_KEY_ID=x run provision --provider aws --destroy --yes
  assert_success
  grep -q "^aws ec2 delete-volume --volume-id vol-0fake0000000000001" "$FAKE_LOG"
  run grep "terminate-instances" "$FAKE_LOG"
  assert_failure
}

@test "a run stopped by a signal after creating the server records it" {
  export FAKE_HCLOUD_SLOW_DESCRIBE=3
  HCLOUD_TOKEN=x "$ROOT/scripts/0-provision.sh" --out "$OUT" --ssh-pubkey "$PUBKEY" --provider hetzner \
    --allow-ip 198.51.100.1/32 --yes >/dev/null 2>&1 3>&- &
  pid=$!
  for _ in $(seq 100); do grep -q "^hcloud server create" "$FAKE_LOG" && break; sleep 0.05; done
  sleep 0.2
  kill -TERM "$pid"
  wait "$pid" || true
  grep -qx "NODE_NAME=fc-node" "$OUT"
}

@test "aws: a rerun that stops half way again updates what node.env records" {
  export FAKE_AWS_NO_CAPACITY=1
  AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  unset FAKE_AWS_NO_CAPACITY
  FAKE_AWS_WAIT_FAIL=1 AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  grep -qx "NODE_SERVER_ID=i-0fake0000000000001" "$OUT"
  : >"$FAKE_LOG"
  AWS_ACCESS_KEY_ID=x run provision --provider aws --destroy --yes
  assert_success
  grep -q "^aws ec2 terminate-instances --instance-ids i-0fake0000000000001" "$FAKE_LOG"
}

@test "--destroy refuses without node.env" {
  HCLOUD_TOKEN=x run provision --provider hetzner --destroy --yes
  assert_failure 2
  assert_output --partial "node.env"
}

@test "a dry run leaves a real node.env alone" {
  printf 'NODE_PROVIDER=hetzner\nNODE_NAME=fc-node\nNODE_IP=198.51.100.7\nNODE_CREATED_AT=2026-10-01T00:00:00Z\n' >"$OUT"
  cp "$OUT" "$BATS_TEST_TMPDIR/before"
  run provision --provider hetzner --dry-run
  assert_success
  assert_output --partial "kept"
  diff "$BATS_TEST_TMPDIR/before" "$OUT"
}

@test "a real run after a dry run records when it ran, so a later dry run keeps its node.env" {
  provision --provider hetzner --dry-run >/dev/null
  HCLOUD_TOKEN=x run provision --provider hetzner --allow-ip 198.51.100.1/32 --yes
  assert_success
  grep -Eqx "NODE_CREATED_AT=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z" "$OUT"
  cp "$OUT" "$BATS_TEST_TMPDIR/before"
  run provision --provider hetzner --dry-run
  assert_success
  diff "$BATS_TEST_TMPDIR/before" "$OUT"
}

@test "--destroy --dry-run deletes nothing, checks nothing and keeps node.env" {
  printf 'NODE_PROVIDER=hetzner\nNODE_NAME=fc-node\nNODE_IP=198.51.100.7\nNODE_CREATED_AT=2026-10-01T00:00:00Z\n' >"$OUT"
  run provision --provider hetzner --destroy --dry-run --yes
  assert_success
  assert_line "DRY: hcloud server delete fc-node"
  [ -f "$OUT" ]
  [ ! -s "$FAKE_LOG" ]
}

@test "--destroy refuses a --provider that differs from node.env" {
  printf 'NODE_PROVIDER=hetzner\nNODE_NAME=fc-node\nNODE_IP=198.51.100.7\n' >"$OUT"
  AWS_ACCESS_KEY_ID=x run provision --provider aws --destroy --yes
  assert_failure 2
  assert_output --partial "hetzner"
  [ ! -s "$FAKE_LOG" ]
}

@test "--destroy asks first and aborts when stdin is closed" {
  provision --provider hetzner --dry-run >/dev/null
  HCLOUD_TOKEN=x run provision --provider hetzner --destroy </dev/null
  assert_failure 2
  run grep delete "$FAKE_LOG"
  assert_failure
}

@test "--destroy --yes deletes the server, then the volume, then the firewall" {
  provision --provider hetzner --dry-run >/dev/null
  export FAKE_HCLOUD_EXISTING="fc-node fc-node-data fc-node-fw"
  HCLOUD_TOKEN=x run provision --provider hetzner --destroy --yes
  assert_success
  run grep " delete" "$FAKE_LOG"
  assert_line --index 0 "hcloud server delete fc-node"
  assert_line --index 1 "hcloud volume delete fc-node-data"
  assert_line --index 2 "hcloud firewall delete fc-node-fw"
}

@test "--destroy removes the node's known_hosts with node.env; a dry run keeps both" {
  provision --provider hetzner --dry-run >/dev/null
  echo "198.51.100.7 ssh-ed25519 AAAA" >"$BATS_TEST_TMPDIR/node.known_hosts"
  run provision --provider hetzner --destroy --dry-run
  [ -f "$BATS_TEST_TMPDIR/node.known_hosts" ]
  HCLOUD_TOKEN=x run provision --provider hetzner --destroy --yes
  assert_success
  [ ! -e "$OUT" ]
  [ ! -e "$BATS_TEST_TMPDIR/node.known_hosts" ]
}

@test "existing host: runs the preflight over ssh and fails with 5 on low RAM" {
  PREFLIGHT_MEM_KB=8000000 PREFLIGHT_FREE_KB=2147483648 run provision --provider existing --host u@127.0.0.1
  assert_failure 5
  assert_output --regexp "ram +7\.6 GiB +15 GiB +no"
  [ ! -f "$OUT" ]
  grep -q "^ssh .* u@127.0.0.1 bash -s" "$FAKE_LOG"
  grep -q -- "-o UserKnownHostsFile=\"$BATS_TEST_TMPDIR/node.known_hosts\" " "$FAKE_LOG"
}

@test "existing host: an ssh connection that fails is exit 4 and says so, not a failed preflight" {
  FAKE_SSH_FAIL_TIMES=99 run provision --provider existing --host u@127.0.0.1
  assert_failure 4
  assert_output --partial "no ssh connection to u@127.0.0.1"
}

@test "records the private key by its absolute path when --ssh-pubkey is relative" {
  cd "$BATS_TEST_TMPDIR"
  cp "$PUBKEY" mine.pub
  run "$ROOT/scripts/0-provision.sh" --out "$OUT" --ssh-pubkey mine.pub --provider hetzner --dry-run
  assert_success
  grep -qx "NODE_SSH_KEY=$BATS_TEST_TMPDIR/mine" "$OUT"
}

@test "--disk-gb below 2000 exits 2: the node needs about 1.8 TiB free" {
  run provision --provider hetzner --disk-gb 1500 --dry-run
  assert_failure 2
  assert_output --partial "2000"
}

@test "aws: an instance without a public IP address stops with exit 4" {
  FAKE_AWS_NO_IP=1 AWS_ACCESS_KEY_ID=x run provision --provider aws --allow-ip 198.51.100.1/32 --yes
  assert_failure 4
  assert_output --partial "public IP"
}

@test "existing host: writes node.env when the preflight passes" {
  PREFLIGHT_MEM_KB=16777216 PREFLIGHT_FREE_KB=2147483648 run provision --provider existing --host u@127.0.0.1
  assert_success
  grep -qx "NODE_IP=127.0.0.1" "$OUT"
  grep -qx "NODE_USER=u" "$OUT"
  grep -qx "NODE_PROVIDER=existing" "$OUT"
}

@test "existing host: CASTY_MIN_FREE_GIB lets a smaller disk through, and only a number" {
  PREFLIGHT_MEM_KB=16777216 PREFLIGHT_FREE_KB=1836098560 run provision --provider existing --host u@127.0.0.1
  assert_failure 5
  assert_output --regexp "disk +1\.71 TiB +1\.8 TiB +no"
  CASTY_MIN_FREE_GIB=1700 PREFLIGHT_MEM_KB=16777216 PREFLIGHT_FREE_KB=1836098560 run provision --provider existing --host u@127.0.0.1
  assert_success
  assert_output --regexp "disk +1\.71 TiB +1700 GiB +yes"
  CASTY_MIN_FREE_GIB="1;id" run provision --provider existing --host u@127.0.0.1
  assert_failure 2
}

@test "existing host: a --host that could pass for an ssh option exits 2" {
  run provision --provider existing --host "-oProxyCommand=sh@127.0.0.1" --dry-run
  assert_failure 2
  run provision --provider existing --host "u@127.0.0.1;id" --dry-run
  assert_failure 2
  [ ! -s "$FAKE_LOG" ]
}

@test "--json prints node.env as JSON" {
  run --separate-stderr provision --provider hetzner --dry-run --json
  assert_success
  [ "$(printf '%s\n' "$output" | grep -v '^DRY:' | jq -r .NODE_PROVIDER)" = hetzner ]
}

@test "without --provider, uses hetzner when only HCLOUD_TOKEN is set" {
  HOME="$BATS_TEST_TMPDIR" HCLOUD_TOKEN=x run provision --dry-run
  assert_success
  assert_output --partial "using hetzner"
  assert_line --partial "DRY: hcloud server create"
}

@test "without --provider, uses aws when only AWS credentials are set" {
  HOME="$BATS_TEST_TMPDIR" AWS_ACCESS_KEY_ID=x run provision --dry-run
  assert_success
  assert_output --partial "using aws"
}

@test "without --provider, an SSO profile in ~/.aws/config counts as AWS credentials" {
  mkdir -p "$BATS_TEST_TMPDIR/.aws"
  printf '[default]\nsso_session = work\nregion = eu-central-1\n' >"$BATS_TEST_TMPDIR/.aws/config"
  HOME="$BATS_TEST_TMPDIR" run provision --dry-run
  assert_success
  assert_output --partial "using aws"
  HOME="$BATS_TEST_TMPDIR" run provision --provider aws --dry-run
  assert_success
}

@test "without --provider, --host means an existing host" {
  HOME="$BATS_TEST_TMPDIR" run provision --host u@127.0.0.1 --dry-run
  assert_success
  assert_output --partial "using existing"
}

@test "without --provider and with no credentials, or two kinds of them, asks for one" {
  HOME="$BATS_TEST_TMPDIR" run provision --dry-run
  assert_failure 2
  assert_output --partial "HCLOUD_TOKEN"
  HOME="$BATS_TEST_TMPDIR" HCLOUD_TOKEN=x AWS_PROFILE=x run provision --dry-run
  assert_failure 2
  assert_output --partial "--provider"
}

@test "ends with the next command: --env only when node.env is elsewhere, --dry-run after a dry run" {
  cd "$BATS_TEST_TMPDIR"
  run "$ROOT/scripts/0-provision.sh" --provider hetzner --dry-run --ssh-pubkey "$PUBKEY"
  assert_success
  assert_line "next: $ROOT/scripts/1-node.sh --dry-run"
  run provision --provider hetzner --dry-run
  assert_line "next: $ROOT/scripts/1-node.sh --env $OUT --dry-run"
}

@test "unknown arguments exit 2" {
  run provision --provider nowhere
  assert_failure 2
  run provision --provider hetzner --bogus
  assert_failure 2
}

@test "--https also opens 80 and 443 to everyone, for 1-node.sh serve --domain; a rerun without it closes them" {
  HCLOUD_TOKEN=x run provision --provider hetzner --https --yes
  assert_success
  rules="$BATS_TEST_TMPDIR/fc-node.firewall.json"
  [ "$(jq -r '[.[] | select(.port == "80" or .port == "443") | .source_ips[]] | unique | join(",")' "$rules")" = "0.0.0.0/0,::/0" ]
  [ "$(jq -r '[.[] | select(.port == "443")] | length' "$rules")" = 1 ]
  assert_output --partial "80 and 443 from anywhere"
  HCLOUD_TOKEN=x run provision --provider hetzner --yes
  assert_success
  [ "$(jq -r '[.[] | select(.port == "443")] | length' "$rules")" = 0 ]
}

@test "aws --https opens 80 and 443 to everyone too, as rules a rerun recognises as casty's" {
  AWS_ACCESS_KEY_ID=x run provision --provider aws --https --yes
  assert_success
  rules="$BATS_TEST_TMPDIR/fc-node.firewall.json"
  [ "$(jq -r '[.[] | select(.FromPort == 80 or .FromPort == 443) | .IpRanges[].CidrIp] | unique | join(",")' "$rules")" = 0.0.0.0/0 ]
  [ "$(jq -r '[.[] | select(.FromPort == 443) | .IpRanges[].Description] | join(",")' "$rules")" = "casty https" ]
  [ "$(jq -r 'index("casty https")' <<<"$(sed -n 's/^AWS_RULE_NAMES=.\(.*\).$/\1/p' "$ROOT/scripts/lib/provider-aws.sh")")" != null ]
  AWS_ACCESS_KEY_ID=x run provision --provider aws --yes
  assert_success
  [ "$(jq -r '[.[] | select(.FromPort == 443)] | length' "$rules")" = 0 ]
}

# A real node's node.env, made in a region and under a name other than the defaults.
recorded_aws_node() {
  printf 'NODE_PROVIDER=aws\nNODE_NAME=mynode\nNODE_REGION=eu-west-1\nNODE_IP=198.51.100.7\nNODE_USER=ubuntu\nNODE_CREATED_AT=2026-10-01T00:00:00Z\n' >"$OUT"
}

@test "a rerun works on the node node.env records: its provider, name and region, not the defaults" {
  recorded_aws_node
  run provision --dry-run --https
  assert_success
  assert_output --partial "eu-west-1"
  assert_output --partial "mynode"
  refute_output --partial "us-east-1"
  refute_output --partial "fc-node"
}

@test "a rerun refuses a region, name or provider other than node.env's, rather than build a second node" {
  recorded_aws_node
  run provision --dry-run --region us-east-1
  assert_failure 2
  assert_output --partial "eu-west-1"
  assert_output --partial "--out"
  run provision --dry-run --name other
  assert_failure 2
  run provision --dry-run --provider hetzner
  assert_failure 2
}
