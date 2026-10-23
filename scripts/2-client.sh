#!/usr/bin/env bash
# Step 2 of 3: put casty in this checkout as ./bin/casty, check it reaches your node, add a
# gasless app key (from your seed phrase, or with --fid later in casty web with your wallet), and
# read your feed. casty is one file from the project's
# releases, built for this machine and checked against its sha256; --from-source builds it here
# with Node and pnpm instead.
set -euo pipefail
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPTS/lib/common.sh"
ROOT=$(cd "$SCRIPTS/.." && pwd)

usage() {
  cat <<'USAGE'
Usage: 2-client.sh [--node <url>] [--fid <fid>] [--from-source] [--no-init]
                   [-- <casty init options>]

  --node <url>    the node's HTTP API (default: http://127.0.0.1:3381, the tunnel from step 1)
  --fid <fid>     no seed phrase: casty init --fid, then add the key in casty web with your wallet
  --from-source   build casty here with Node 22.12 or newer and pnpm, instead of downloading it
  --no-init       stop after casty doctor; run ./bin/casty init yourself later
  -- <options>    passed to casty init, e.g. -- --address-index 1

Without --fid, casty init asks for your seed phrase. Use a test account for this.

The download is casty-<os>-<arch> and SHA256SUMS from CASTY_RELEASE_URL, by default this
project's latest GitHub release, which has linux-x64, linux-arm64 and darwin-arm64.

Exit codes: 0 ok, 2 bad arguments, 3 missing prerequisite, 4 node unreachable or no good download,
5 key problem.
USAGE
}

NODE_URL=http://127.0.0.1:3381 FID="" INIT=1 FROM_SOURCE=0 INIT_ARGS=()
while [ $# -gt 0 ]; do
  case $1 in
    --node)
      [ $# -ge 2 ] || die "$EXIT_USAGE" "--node needs a value"
      NODE_URL=$2
      shift
      ;;
    --fid)
      [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || die "$EXIT_USAGE" "--fid takes a number, the fid"
      FID=$2
      shift
      ;;
    --from-source) FROM_SOURCE=1 ;;
    --no-init) INIT=0 ;;
    --) shift && INIT_ARGS=("$@") && break ;;
    -h | --help) usage && exit 0 ;;
    *) die "$EXIT_USAGE" "unknown argument $1 (see --help)" ;;
  esac
  shift
done

RELEASE_URL=${CASTY_RELEASE_URL:-https://github.com/savvax/casty/releases/latest/download}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# This machine as the releases name it: linux-x64, linux-arm64, darwin-arm64.
platform() {
  local arch
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) arch=$(uname -m) ;;
  esac
  printf '%s-%s\n' "$(uname -s | tr '[:upper:]' '[:lower:]')" "$arch"
}

# One file, built with bun: the client, its dependencies and the web page. Installed only once
# its sha256 is the one the release lists next to it.
install_release() {
  local platform file want got
  platform=$(platform)
  case $platform in
    linux-x64 | linux-arm64 | darwin-arm64) ;;
    *) die "$EXIT_PREREQ" "no casty binary is built for $platform; run this script with --from-source, which needs Node 22.12 or newer" ;;
  esac
  require_cmd curl "Install it with your package manager."
  file="casty-$platform"
  log "downloading $file from $RELEASE_URL"
  # A redirect (GitHub's, to its file store) may go to https only.
  if ! { curl -fsSL --proto-redir =https -o "$WORK/$file" "$RELEASE_URL/$file" && curl -fsSL --proto-redir =https -o "$WORK/SHA256SUMS" "$RELEASE_URL/SHA256SUMS"; }; then
    # A checkout that was never released, or no connection: the source is right here.
    warn "no release for $platform at $RELEASE_URL, or no connection; building casty from source instead"
    build_from_source
    return 0
  fi
  want=$(sed -n "s/^\([0-9a-f]\{64\}\)  $file\$/\1/p" "$WORK/SHA256SUMS")
  got=$(sha256_hex <"$WORK/$file")
  [ -n "$want" ] && [ "$want" = "$got" ] ||
    die "$EXIT_PROVIDER" "the sha256 of the downloaded $file is $got, not the ${want:-missing} SHA256SUMS lists; nothing was installed"
  mkdir -p "$ROOT/bin"
  chmod +x "$WORK/$file"
  mv "$WORK/$file" "$ROOT/bin/casty"
}

build_from_source() {
  local hint version major minor pnpm
  hint="Install Node 22.12 or newer, e.g. with fnm (fnm install 22, https://github.com/Schniz/fnm) or nvm (nvm install 22, https://github.com/nvm-sh/nvm)."
  require_cmd node "$hint"
  version=$(node -p 'process.versions.node')
  IFS=. read -r major minor _ <<<"$version"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 12 ]; }; then
    die "$EXIT_PREREQ" "Node $version is too old; casty needs 22.12 or newer. $hint"
  fi
  # corepack runs the pnpm package.json pins without `corepack enable`, which writes shims next
  # to node and fails without root when Node is a system package.
  if command -v corepack >/dev/null 2>&1; then
    pnpm=(corepack pnpm)
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm=(pnpm)
  else
    die "$EXIT_PREREQ" "neither corepack nor pnpm is installed. Node 25 and later no longer bundle corepack: npm install -g corepack"
  fi
  # Only what the client runs on, and esbuild, which builds it: the client's test tools, the docs
  # site and the repository's own tools would more than double node_modules. A checkout that
  # already has them (pnpm install, as the README's offline workflow runs first) keeps them:
  # --prod would have pnpm remove them, asking first, or refusing with no terminal.
  local install=(install --frozen-lockfile --prod --filter @casty/client)
  grep -q '"devDependencies": true' "$ROOT/node_modules/.modules.yaml" 2>/dev/null &&
    install=(install --frozen-lockfile)
  log "installing the client's dependencies and building it"
  (cd "$ROOT" && "${pnpm[@]}" "${install[@]}" && "${pnpm[@]}" --filter @casty/client build)
  mkdir -p "$ROOT/bin"
  # The checkout's absolute path, not one relative to $0, so a symlink to the wrapper works too.
  # shellcheck disable=SC2016 # the wrapper expands "$@" when it runs
  printf '#!/bin/sh\nexec node %s "$@"\n' "$(quote "$ROOT/client/dist/casty.js")" >"$ROOT/bin/casty"
  chmod +x "$ROOT/bin/casty"
}

if [ "$FROM_SOURCE" = 1 ]; then build_from_source; else install_release; fi
CASTY="$ROOT/bin/casty"

log "checking the node at $NODE_URL"
code=0
"$CASTY" doctor --node "$NODE_URL" || code=$?
if [ "$code" != 0 ]; then
  log "casty could not use the node at $NODE_URL; if it runs on your host, open the tunnel: ./scripts/1-node.sh tunnel"
  exit "$code"
fi

if [ "$INIT" = 0 ]; then
  log "skipped casty init; when you are ready: ./bin/casty init --node $NODE_URL"
  exit 0
fi
# Re-running this script must not add a key each time.
keyless=0
if "$CASTY" whoami --node "$NODE_URL" --json 2>/dev/null | grep '"activeKey": "0x' >/dev/null; then
  log "casty already has an active app key for this fid; ./bin/casty init adds another"
elif [ -n "$FID" ]; then
  "$CASTY" init --node "$NODE_URL" --fid "$FID"
  keyless=1
else
  log "casty init asks for your seed phrase next: use a test account, or run this script again with --fid <fid> to add the key with your wallet instead"
  "$CASTY" init --node "$NODE_URL" ${INIT_ARGS[@]+"${INIT_ARGS[@]}"}
fi
"$CASTY" feed --node "$NODE_URL" --limit 20

shown=./bin/casty node=""
[ "$PWD" = "$ROOT" ] || shown=$CASTY
[ "$NODE_URL" = http://127.0.0.1:3381 ] || node=" --node $NODE_URL"
if [ "$keyless" = 1 ]; then
  cat >&2 <<NEXT

casty reads as fid $FID and holds no app key yet. To add one with your wallet, no seed phrase typed:
  $shown web$node
then open the link it prints and, under you, choose "add a key with your wallet".
NEXT
else
  cat >&2 <<NEXT

casty is ready; $shown --help lists every command. A few to try:
  $shown cast "hello from my own node"$node
  $shown like 1$node                the first cast above
  $shown feed --since 24h --no-replies$node
NEXT
fi
log "To type casty instead: ln -s $CASTY ~/.local/bin/casty"
