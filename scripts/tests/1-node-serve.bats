#!/usr/bin/env bats
# 1-node.sh serve: casty on the node's host, reached over HTTPS from any network.
load helpers

setup_file() { start_mock; }
teardown_file() { stop_mock; }
setup() {
  setup_node
  # The laptop's casty config: an fid and an encrypted key store (its content does not matter
  # here; the script copies it, never opens it).
  CONFIG="$BATS_TEST_TMPDIR/config/casty"
  mkdir -p "$CONFIG"
  printf '{"fid":2000000001,"custodyAddress":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","keys":["0xab"]}\n' >"$CONFIG/config.json"
  printf '{"v":1,"kdf":{"name":"scrypt"},"cipher":"xchacha20poly1305","nonce":"00","ct":"00"}\n' >"$CONFIG/keys.enc.json"
  chmod 600 "$CONFIG/keys.enc.json"
  # The service writes its pairing token into the config directory it is given; here it is
  # already there, as after a start.
  mkdir -p "$REMOTE/casty/config"
  printf 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ\n' >"$REMOTE/casty/config/web-token"
  export CASTY_PASSPHRASE=secret-pass SERVE_TRIES=3 SERVE_SLEEP=0
}
teardown() { teardown_node; }

serve() { node_sh serve --config "$CONFIG" "$@"; }

@test "serve --domain ships the client's source, a Dockerfile and a Caddyfile, builds the image and starts casty and caddy" {
  run serve --domain node.example.org
  assert_success
  [ -f "$REMOTE/casty/src/client/src/cli/index.ts" ]
  [ -f "$REMOTE/casty/src/pnpm-lock.yaml" ]
  [ -f "$REMOTE/casty/src/client/build.mjs" ]
  [ ! -e "$REMOTE/casty/src/client/node_modules" ]
  [ ! -e "$REMOTE/casty/src/client/test" ]
  # The Dockerfile sits in the build context, where compose looks for it.
  [ ! -e "$REMOTE/casty/Dockerfile" ]
  grep -q "^FROM node:22-alpine" "$REMOTE/casty/src/Dockerfile"
  grep -q "^node.example.org {" "$REMOTE/casty/Caddyfile"
  grep -q "reverse_proxy casty:3390" "$REMOTE/casty/Caddyfile"
  [ "$(yq '.services.casty.build' "$REMOTE/docker-compose.casty.yml")" = ./casty/src ]
  # Snapchain's compose file puts its services on a network of their own; casty joins it.
  [ "$(yq '.services.casty.networks[0]' "$REMOTE/docker-compose.casty.yml")" = snapchain ]
  [ "$(yq '.services.caddy.networks[0]' "$REMOTE/docker-compose.casty.yml")" = snapchain ]
  [ "$(yq '.services.casty.command | join(" ")' "$REMOTE/docker-compose.casty.yml")" = "serve --node http://snapchain:3381 --public-host node.example.org --listen 0.0.0.0:3390" ]
  [ "$(yq '.services.casty.restart' "$REMOTE/docker-compose.casty.yml")" = unless-stopped ]
  [ "$(yq '.services.caddy.image' "$REMOTE/docker-compose.casty.yml")" = caddy:2-alpine ]
  [ "$(yq '.services.caddy.ports | join(",")' "$REMOTE/docker-compose.casty.yml")" = "80:80,443:443" ]
  grep -qx "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.casty.yml" "$REMOTE/.env"
  grep -q "docker compose build casty" "$FAKE_LOG"
  grep -q "docker compose up -d --remove-orphans casty caddy" "$FAKE_LOG"
  # The token is read through the container, which a non-root login could not read as a file.
  grep -q "docker compose exec -T casty cat /config/casty/web-token" "$FAKE_LOG"
  assert_output --partial "https://node.example.org/#token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
  assert_output --partial "0-provision.sh --https"
}

@test "serve copies the key store and config to the host, mode 0600, and the passphrase as a docker secret" {
  run serve --domain node.example.org
  assert_success
  cmp "$CONFIG/keys.enc.json" "$REMOTE/casty/config/keys.enc.json"
  cmp "$CONFIG/config.json" "$REMOTE/casty/config/config.json"
  [ "$(stat -f %Lp "$REMOTE/casty/config/keys.enc.json" 2>/dev/null || stat -c %a "$REMOTE/casty/config/keys.enc.json")" = 600 ]
  [ "$(cat "$REMOTE/casty/passphrase")" = secret-pass ]
  [ "$(stat -f %Lp "$REMOTE/casty/passphrase" 2>/dev/null || stat -c %a "$REMOTE/casty/passphrase")" = 600 ]
  [ "$(yq '.services.casty.environment.CASTY_PASSPHRASE_FILE' "$REMOTE/docker-compose.casty.yml")" = /run/secrets/casty_passphrase ]
  [ "$(yq '.secrets.casty_passphrase.file' "$REMOTE/docker-compose.casty.yml")" = ./casty/passphrase ]
  refute_output --partial "secret-pass"
}

@test "serve --read-only ships no key store and no passphrase, removes one shipped before, and the service reads only" {
  unset CASTY_PASSPHRASE
  printf 'from an earlier run\n' >"$REMOTE/casty/config/keys.enc.json"
  run serve --domain node.example.org --read-only
  assert_success
  [ ! -e "$REMOTE/casty/config/keys.enc.json" ]
  [ ! -s "$REMOTE/casty/passphrase" ]
  [ "$(yq '.services.casty.command[-1]' "$REMOTE/docker-compose.casty.yml")" = --read-only ]
}

@test "serve --tailscale publishes casty on the host's loopback and serves it over the tailnet" {
  run serve --tailscale
  assert_success
  [ "$(yq '.services.casty.ports[0]' "$REMOTE/docker-compose.casty.yml")" = "127.0.0.1:3390:3390" ]
  [ "$(yq '.services | keys | join(",")' "$REMOTE/docker-compose.casty.yml")" = casty ]
  [ ! -e "$REMOTE/casty/Caddyfile" ]
  grep -q "docker compose up -d --remove-orphans casty$" "$FAKE_LOG"
  grep -q "tailscale serve --bg 3390" "$FAKE_LOG"
  [ "$(yq '.services.casty.command | join(" ")' "$REMOTE/docker-compose.casty.yml")" = "serve --node http://snapchain:3381 --public-host fc-node.tail1234.ts.net --listen 0.0.0.0:3390" ]
  assert_output --partial "https://fc-node.tail1234.ts.net/#token="
  refute_output --partial "0-provision.sh --https"
}

@test "serve --domain --dry-run prints the ssh calls, equal to the golden, and changes nothing" {
  rm -rf "$REMOTE/casty"
  run serve --domain node.example.org --dry-run
  assert_success
  assert_golden serve
  [ ! -e "$REMOTE/casty" ]
}

@test "serve asks for the passphrase on a terminal, and without one says to set CASTY_PASSPHRASE" {
  unset CASTY_PASSPHRASE
  run serve --domain node.example.org
  assert_failure 3
  assert_output --partial "CASTY_PASSPHRASE"
  [ ! -e "$REMOTE/casty/passphrase" ]
}

@test "serve needs --domain or --tailscale, one of them, and a casty config with an app key" {
  run serve
  assert_failure 2
  assert_output --partial "--domain"
  run serve --domain node.example.org --tailscale
  assert_failure 2
  run node_sh serve --domain node.example.org --config "$BATS_TEST_TMPDIR/nowhere"
  assert_failure 3
  assert_output --partial "casty init"
  rm "$CONFIG/keys.enc.json"
  run serve --domain node.example.org
  assert_failure 3
  assert_output --partial "keys.enc.json"
  assert_output --partial "add a key with your wallet"
  assert_output --partial "--read-only"
}

@test "serve waits for the service to write its token, and gives up with the logs" {
  rm "$REMOTE/casty/config/web-token"
  run serve --domain node.example.org
  assert_failure 1
  assert_output --partial "docker compose logs"
  [ "$(grep -c '^ssh .*web-token' "$FAKE_LOG")" = 3 ]
}

@test "serve on a rerun trusts a running container, not a token file an earlier run left" {
  FAKE_DOCKER_EXEC_FAIL=1 run serve --domain node.example.org
  assert_failure 1
  refute_output --partial "open to pair"
}

@test "serve --tailscale needs jq before it talks to the host" {
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
  PATH="$nojq" run serve --tailscale
  assert_failure 3
  assert_output --partial "jq is not installed"
  [ ! -s "$FAKE_LOG" ]
}

@test "logs casty follows the service's logs" {
  mkdir -p "$REMOTE"
  node_sh logs casty >/dev/null
  grep -q "docker compose logs -f --tail 100 casty" "$FAKE_LOG"
}

@test "serve --dry-run prints its commands before casty has a config, as deploy.sh --dry-run runs it" {
  run node_sh serve --domain node.example.org --dry-run --config "$BATS_TEST_TMPDIR/nowhere"
  assert_success
  assert_output --partial "no casty config"
  assert_output --partial "DRY:"
}
