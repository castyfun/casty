#!/usr/bin/env bats
load helpers

setup_file() {
  pnpm --dir "$ROOT" --filter @casty/client build >/dev/null
  start_mock
}
teardown_file() { stop_mock; }

setup() {
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  export CALLS="$BATS_TEST_TMPDIR/calls.log"
  : >"$CALLS"
  for tool in pnpm corepack; do
    printf '#!/usr/bin/env bash\nprintf "%s %%s\\n" "$*" >>"$CALLS"\n' "$tool" >"$BIN/$tool"
    chmod +x "$BIN/$tool"
  done
  export PATH="$BIN:$PATH"
}

# Whatever a test installed as bin/casty, the developer's own comes back.
teardown() {
  [ ! -e "$BATS_TEST_TMPDIR/casty.before" ] || mv -f "$BATS_TEST_TMPDIR/casty.before" "$ROOT/bin/casty"
}

client() { "$ROOT/scripts/2-client.sh" "$@" </dev/null; }

@test "the build is one entry file, chunks loaded on first use, and the web page beside them" {
  [ -f "$ROOT/client/dist/casty.js" ]
  [ -f "$ROOT/client/dist/assets/index.html" ]
  [ -f "$ROOT/client/dist/assets/app.js" ]
  head -1 "$ROOT/client/dist/casty.js" | grep -qx '#!/usr/bin/env node'
  # Signing code is a chunk of its own, so a read never loads it.
  run grep -l "makeCastAdd" "$ROOT/client/dist/casty.js"
  assert_failure
  run node "$ROOT/client/dist/casty.js" web --help
  assert_success
  assert_output --partial "--listen"
}

@test "--from-source refuses Node older than 22.12, pointing at fnm and nvm" {
  printf '#!/bin/sh\necho 22.11.0\n' >"$BIN/node"
  chmod +x "$BIN/node"
  run client --from-source --no-init
  assert_failure 3
  assert_output --partial "22.12"
  assert_output --partial "fnm"
  assert_output --partial "nvm"
}

# A checkout with no node_modules, as a user's fresh clone is: the scripts copied, the client
# linked, so the wrapper runs the client built in setup_file.
fresh_checkout() {
  FRESH="$BATS_TEST_TMPDIR/checkout"
  mkdir -p "$FRESH"
  cp -R "$ROOT/scripts" "$FRESH/scripts"
  ln -s "$ROOT/client" "$FRESH/client"
}

@test "--from-source installs the client's dependencies from the lockfile and builds it with corepack's pnpm, enabling nothing" {
  fresh_checkout
  run "$FRESH/scripts/2-client.sh" --from-source --node "$NODE_API" --no-init </dev/null
  assert_success
  grep -qx "corepack pnpm install --frozen-lockfile --prod --filter @casty/client" "$CALLS"
  grep -qx "corepack pnpm --filter @casty/client build" "$CALLS"
  run grep enable "$CALLS"
  assert_failure
  [ -x "$FRESH/bin/casty" ]
}

@test "--from-source in a checkout with the dev tools installed keeps them, not asking pnpm to remove them" {
  # This checkout ran pnpm install, as the README's offline workflow does first.
  grep -q '"devDependencies": true' "$ROOT/node_modules/.modules.yaml"
  run client --from-source --node "$NODE_API" --no-init
  assert_success
  grep -qx "corepack pnpm install --frozen-lockfile" "$CALLS"
  run grep -- --prod "$CALLS"
  assert_failure
}

@test "./bin/casty works through the symlink the script suggests" {
  run client --from-source --node "$NODE_API" --no-init
  assert_success
  ln -s "$ROOT/bin/casty" "$BATS_TEST_TMPDIR/casty"
  run "$BATS_TEST_TMPDIR/casty" --help
  assert_success
  assert_output --partial "Usage: casty"
}

@test "runs casty doctor against the node" {
  run client --from-source --node "$NODE_API" --no-init
  assert_success
  assert_output --partial "synced"
  assert_output --partial "0.0.0-mock"
}

@test "--no-init stops after doctor" {
  run client --from-source --node "$NODE_API" --no-init
  assert_success
  refute_output --partial "seed phrase"
  assert_output --partial "casty init"
}

@test "a node it cannot reach exits 4 with the tunnel hint" {
  run client --from-source --node http://127.0.0.1:9 --no-init
  assert_failure 4
  assert_output --partial "1-node.sh tunnel"
}

@test "a second run keeps the app key it already has instead of adding another" {
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config"
  printf 'test test test test test test test test test test test junk\n' |
    CASTY_PASSPHRASE=x "$ROOT/client/dist/casty.js" init --mnemonic-stdin --node "$NODE_API" >/dev/null 2>&1
  before=$(curl -fsS "$NODE_API/__mock/state" | jq .signers)
  CASTY_PASSPHRASE=x run client --from-source --node "$NODE_API"
  assert_success
  assert_output --partial "already has an active app key"
  [ "$(curl -fsS "$NODE_API/__mock/state" | jq .signers)" = "$before" ]
}

@test "ends with a few commands to try and how to put casty on the PATH" {
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config"
  printf 'test test test test test test test test test test test junk\n' |
    CASTY_PASSPHRASE=x "$ROOT/client/dist/casty.js" init --mnemonic-stdin --node "$NODE_API" >/dev/null 2>&1
  CASTY_PASSPHRASE=x run client --from-source --node "$NODE_API"
  assert_success
  assert_output --partial "bin/casty cast"
  assert_output --partial "bin/casty like 1"
  assert_output --partial "ln -s $ROOT/bin/casty"
}

# The release path: a "release" directory served over file://, which curl reads like https://.
release() {
  RELEASE="$BATS_TEST_TMPDIR/release"
  mkdir -p "$RELEASE"
  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(case $(uname -m) in (x86_64 | amd64) echo x64 ;; (arm64 | aarch64) echo arm64 ;; (*) uname -m ;; esac)"
  printf '#!/bin/sh\necho "stub casty $*"\n' >"$RELEASE/casty-$PLATFORM"
  (cd "$RELEASE" && shasum -a 256 "casty-$PLATFORM" >SHA256SUMS)
  export CASTY_RELEASE_URL="file://$RELEASE"
  [ ! -e "$ROOT/bin/casty" ] || mv "$ROOT/bin/casty" "$BATS_TEST_TMPDIR/casty.before"
}

@test "downloads the release binary for this machine, checks its sha256 and installs it as ./bin/casty" {
  release
  run client --node "$NODE_API" --no-init
  assert_success
  assert_output --partial "casty-$PLATFORM"
  [ -x "$ROOT/bin/casty" ]
  cmp "$ROOT/bin/casty" "$RELEASE/casty-$PLATFORM"
  assert_output --partial "stub casty doctor"
  [ ! -s "$CALLS" ]
}

@test "refuses a download whose sha256 is not the one SHA256SUMS lists, and installs nothing" {
  release
  printf '#!/bin/sh\necho tampered\n' >"$RELEASE/casty-$PLATFORM"
  run client --node "$NODE_API" --no-init
  assert_failure 4
  assert_output --partial "sha256"
  [ ! -e "$ROOT/bin/casty" ]
}

@test "with no release to download, builds from source instead and says so" {
  release
  rm "$RELEASE/casty-$PLATFORM"
  run client --node "$NODE_API" --no-init
  assert_success
  assert_output --partial "no release"
  assert_output --partial "building casty from source"
  grep -qx "corepack pnpm --filter @casty/client build" "$CALLS"
  [ -x "$ROOT/bin/casty" ]
}

@test "with no release to download and Node too old, stops with exit 3 and the Node hint" {
  release
  rm "$RELEASE/casty-$PLATFORM"
  printf '#!/bin/sh\necho 22.11.0\n' >"$BIN/node"
  chmod +x "$BIN/node"
  run client --node "$NODE_API" --no-init
  assert_failure 3
  assert_output --partial "no release"
  assert_output --partial "22.12"
  [ ! -e "$ROOT/bin/casty" ]
}

@test "a machine no binary is built for is told to build from source" {
  release
  printf '#!/bin/sh\n[ "$1" = -m ] && echo mips64 || echo Linux\n' >"$BIN/uname"
  chmod +x "$BIN/uname"
  run client --node "$NODE_API" --no-init
  assert_failure 3
  assert_output --partial "linux-mips64"
  assert_output --partial "--from-source"
}

@test "--from-source needs no release: it builds with Node and pnpm" {
  release
  rm "$RELEASE/casty-$PLATFORM"
  run client --node "$NODE_API" --no-init --from-source
  assert_success
  grep -qx "corepack pnpm --filter @casty/client build" "$CALLS"
  [ -x "$ROOT/bin/casty" ]
}

@test "--help names --fid, the path with no seed phrase" {
  run client --help
  assert_success
  assert_output --partial "--fid <fid>"
}

@test "--fid sets casty up with no seed phrase and points at casty web and the wallet" {
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config"
  before=$(curl -fsS "$NODE_API/__mock/state" | jq .signers)
  run client --from-source --node "$NODE_API" --fid 2000000001
  assert_success
  refute_output --partial "seed phrase controls"
  assert_output --partial "casty web"
  assert_output --partial "add a key with your wallet"
  jq -e '.fid == 2000000001' "$XDG_CONFIG_HOME/casty/config.json" >/dev/null
  [ "$(curl -fsS "$NODE_API/__mock/state" | jq .signers)" = "$before" ]
}

@test "--fid needs a number" {
  run client --fid @alice
  assert_failure 2
  assert_output --partial "--fid takes a number"
}

@test "before casty init asks for the seed phrase, says to use a test account and names --fid" {
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config"
  run bash -c "printf 'test test test test test test test test test test test junk\n' | CASTY_PASSPHRASE=x '$ROOT/scripts/2-client.sh' --from-source --node '$NODE_API' -- --mnemonic-stdin"
  assert_success
  assert_output --partial "use a test account, or run this script again with --fid <fid>"
  assert_output --partial "A seed phrase controls the whole account"
}
