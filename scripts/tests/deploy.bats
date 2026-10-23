#!/usr/bin/env bats
# deploy.sh: the whole setup in one command, as the three steps and serve in order. The steps are
# stand-ins here that record their calls; each has its own suite.
load helpers

setup() {
  setup_fakes
  # A copy of deploy.sh beside stand-in steps, so the script runs its siblings as it would.
  STAGE="$BATS_TEST_TMPDIR/scripts"
  mkdir -p "$STAGE"
  cp "$ROOT/scripts/deploy.sh" "$STAGE/"
  cp -R "$ROOT/scripts/lib" "$STAGE/lib"
  export CALLS="$BATS_TEST_TMPDIR/calls.log"
  : >"$CALLS"
  for step in 0-provision.sh 1-node.sh 2-client.sh; do
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >>"$CALLS"\n[ "$1" != --help ] || echo "Usage: %s"\nexit "${FAKE_EXIT_%s:-0}"\n' \
      "$step" "$step" "${step%%-*}" >"$STAGE/$step"
    chmod +x "$STAGE/$step"
  done
  cd "$BATS_TEST_TMPDIR" || return 1
}

deploy() { "$STAGE/deploy.sh" "$@" </dev/null; }

@test "runs provisioning, the node, the client and serve in order, with the flags each step needs" {
  run deploy --domain node.example.org --from-source
  assert_success
  [ "$(sed -n 1p "$CALLS")" = "0-provision.sh --out node.env --https" ]
  [ "$(sed -n 2p "$CALLS")" = "1-node.sh --env node.env" ]
  [ "$(sed -n 3p "$CALLS")" = "2-client.sh --from-source" ]
  [ "$(sed -n 4p "$CALLS")" = "1-node.sh --env node.env serve --domain node.example.org" ]
  [ "$(grep -c "" "$CALLS")" = 4 ]
  assert_output --partial "step 1 of 4"
  assert_output --partial "step 4 of 4"
}

@test "without --domain or --tailscale, sets up the node and the client and stops there" {
  run deploy
  assert_success
  [ "$(sed -n 1p "$CALLS")" = "0-provision.sh --out node.env" ]
  [ "$(grep -c "" "$CALLS")" = 3 ]
  assert_output --partial "step 3 of 3"
  assert_output --partial "deploy.sh --domain"
}

@test "skips provisioning when node.env already describes a node" {
  printf 'NODE_PROVIDER=hetzner\nNODE_IP=203.0.113.50\n' >node.env
  run deploy --tailscale --read-only
  assert_success
  run grep "^0-provision" "$CALLS"
  assert_failure
  grep -qx "1-node.sh --env node.env serve --tailscale --read-only" "$CALLS"
}

@test "stops at the first step that fails, with its exit code, and says the same command resumes" {
  FAKE_EXIT_1=5 run deploy --domain node.example.org
  assert_failure 5
  [ "$(grep -c "" "$CALLS")" = 2 ]
  assert_output --partial "stopped at step 2 of 4"
  assert_output --partial "run the same command again"
}

@test "--dry-run reaches provisioning and the node, and skips the client, which has no dry run" {
  run deploy --dry-run --domain node.example.org
  assert_success
  assert_output --partial "dry run done: nothing was created"
  refute_output --partial "the page is up"
  grep -qx "0-provision.sh --out node.env --https --dry-run" "$CALLS"
  grep -qx "1-node.sh --env node.env --dry-run" "$CALLS"
  run grep "^2-client" "$CALLS"
  assert_failure
  grep -qx "1-node.sh --env node.env serve --domain node.example.org --dry-run" "$CALLS"
}

@test "passes what follows -- to provisioning, and --env and --yes where they belong" {
  run deploy --env other.env --yes -- --provider aws --region eu-west-1
  assert_success
  grep -qx "0-provision.sh --out other.env --yes --provider aws --region eu-west-1" "$CALLS"
  grep -qx "1-node.sh --env other.env" "$CALLS"
}

@test "refuses both fronts, an unknown argument, and prints its help" {
  run deploy --domain a --tailscale
  assert_failure 2
  run deploy --nope
  assert_failure 2
  run deploy --help
  assert_success
  assert_output --partial "Usage: deploy.sh"
  [ ! -s "$CALLS" ]
}

@test "--fid goes to 2-client.sh, the path with no seed phrase" {
  run deploy --fid 2000000001
  assert_success
  [ "$(sed -n 3p "$CALLS")" = "2-client.sh --fid 2000000001" ]
}

@test "--fid needs a number, checked before anything is provisioned" {
  run deploy --fid @alice
  assert_failure 2
  assert_output --partial "--fid takes a number"
  [ ! -s "$CALLS" ]
}

@test "a dry run's node.env describes no host: the real run that follows provisions one" {
  printf 'NODE_PROVIDER=hetzner\nNODE_IP=192.0.2.1\nNODE_CREATED_AT=dry-run\n' >node.env
  run deploy
  assert_success
  grep -qx "0-provision.sh --out node.env" "$CALLS"
}

@test "--domain on a node a cloud made before opens 80 and 443 there, on the same node" {
  printf 'NODE_PROVIDER=hetzner\nNODE_IP=203.0.113.50\nNODE_CREATED_AT=2026-10-01T00:00:00Z\n' >node.env
  run deploy --domain node.example.org
  assert_success
  [ "$(sed -n 1p "$CALLS")" = "0-provision.sh --out node.env --https" ]
}

@test "--domain on an existing host leaves its firewall to its owner" {
  printf 'NODE_PROVIDER=existing\nNODE_IP=203.0.113.50\nNODE_CREATED_AT=2026-10-01T00:00:00Z\n' >node.env
  run deploy --domain node.example.org
  assert_success
  run grep "^0-provision" "$CALLS"
  assert_failure
}

@test "the closing hint repeats --fid, --env and --from-source" {
  run deploy --fid 2000000001 --env other.env --from-source
  assert_success
  assert_output --partial "deploy.sh --fid 2000000001 --env other.env --from-source --domain <name>"
}
