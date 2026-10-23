#!/usr/bin/env bash
# The whole setup in one command: a host, the node, the client and, with a front named, the page
# on the host. Each step is one of the scripts beside this one, and each is safe to run again, so
# a run that stops (the first sync takes hours; a step may fail) is picked up by the same command.
set -euo pipefail
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPTS/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: deploy.sh [--domain <name> | --tailscale] [--read-only] [--fid <fid>] [--from-source]
                 [--env <file>] [--yes] [--dry-run] [-- <0-provision.sh options>]

  Runs, in order: 0-provision.sh (unless --env's file already describes a host; with --domain,
  again on that host to open 80 and 443), 1-node.sh (the node, the wait for its sync, the
  tunnel), 2-client.sh (the client, an app key, the feed) and, with a front named, 1-node.sh
  serve. Every step is safe to run again: the same command picks up where a run stopped.

  --domain <name>   serve the page on the host as https://<name> (Caddy; opens 80 and 443)
  --tailscale       serve it as the host's name on your tailnet instead
  --read-only       a page that reads only: no app key or passphrase leaves this machine
  --fid <fid>       no seed phrase: 2-client.sh --fid; add the key in ./bin/casty web with your
                    wallet, then run the same command again for the page on the host
  --from-source     build the client here with Node and pnpm instead of downloading it
  --env <file>      node.env to write or read (default: node.env)
  --yes             do not ask before creating anything
  --dry-run         print what provisioning and the node would run; the client is skipped
  -- <options>      passed to 0-provision.sh, e.g. -- --provider aws --region eu-west-1

Exit codes: 0 ok, 2 bad arguments, otherwise the code of the step that stopped.
USAGE
}

DOMAIN="" TAILSCALE=0 READ_ONLY=0 FID="" FROM_SOURCE=0 ENV_FILE=node.env YES=0 PASS=()
while [ $# -gt 0 ]; do
  case $1 in
    --domain | --env)
      [ $# -ge 2 ] || die "$EXIT_USAGE" "$1 needs a value"
      case $1 in
        --domain) DOMAIN=$2 ;;
        --env) ENV_FILE=$2 ;;
      esac
      shift
      ;;
    --fid)
      [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || die "$EXIT_USAGE" "--fid takes a number, the fid"
      FID=$2
      shift
      ;;
    --tailscale) TAILSCALE=1 ;;
    --read-only) READ_ONLY=1 ;;
    --from-source) FROM_SOURCE=1 ;;
    --yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --) shift && PASS=("$@") && break ;;
    -h | --help) usage && exit 0 ;;
    *) die "$EXIT_USAGE" "unknown argument $1 (see --help)" ;;
  esac
  shift
done
[ -z "$DOMAIN" ] || [ "$TAILSCALE" = 0 ] || die "$EXIT_USAGE" "--domain and --tailscale are two ways to reach the page; pick one"

STEPS=3
[ -z "$DOMAIN" ] && [ "$TAILSCALE" = 0 ] || STEPS=4
STEP=0

# step <what it does> <command...>: runs one step; a failure ends the run with that step's code.
step() {
  local what=$1 code
  shift
  STEP=$((STEP + 1))
  log "step $STEP of $STEPS: $what"
  "$@" || {
    code=$?
    log "stopped at step $STEP of $STEPS (exit $code); fix what it said, then run the same command again: the steps done are kept"
    exit "$code"
  }
}

# 0: a host. One that node.env already describes is kept; a dry run's placeholders describe none.
# A page on a domain needs 80 and 443 open, so a node a cloud made gets its firewall again, which
# 0-provision.sh does on the node node.env records; an existing host's firewall is its owner's.
provision=("$SCRIPTS/0-provision.sh" --out "$ENV_FILE")
[ -z "$DOMAIN" ] || provision+=(--https)
[ "$YES" = 0 ] || provision+=(--yes)
[ "$DRY_RUN" = 0 ] || provision+=(--dry-run)
if [ -f "$ENV_FILE" ] && [ -n "$(env_value "$ENV_FILE" NODE_IP)" ] && [ "$(env_value "$ENV_FILE" NODE_CREATED_AT)" != dry-run ]; then
  if [ -n "$DOMAIN" ] && [ "$(env_value "$ENV_FILE" NODE_PROVIDER)" != existing ]; then
    step "80 and 443 opened on the node $ENV_FILE describes" "${provision[@]}"
  else
    STEP=1
    log "step 1 of $STEPS: $ENV_FILE describes a host already; provisioning skipped"
  fi
else
  step "a host for the node" "${provision[@]}" ${PASS[@]+"${PASS[@]}"}
fi

# 1: the node, synced, with the tunnel.
node=("$SCRIPTS/1-node.sh" --env "$ENV_FILE")
[ "$DRY_RUN" = 0 ] || node+=(--dry-run)
step "the node, its sync and the tunnel" "${node[@]}"

# 2: the client, an app key, your feed.
if [ "$DRY_RUN" = 1 ]; then
  STEP=$((STEP + 1))
  log "step $STEP of $STEPS: 2-client.sh has no dry run; skipped"
else
  client=("$SCRIPTS/2-client.sh")
  [ "$FROM_SOURCE" = 0 ] || client+=(--from-source)
  [ -z "$FID" ] || client+=(--fid "$FID")
  step "the client and your app key" "${client[@]}"
fi

# 3: the page on the host, from any network.
if [ "$STEPS" = 4 ]; then
  serve=("${node[@]:0:3}" serve)
  [ -z "$DOMAIN" ] || serve+=(--domain "$DOMAIN")
  [ "$TAILSCALE" = 0 ] || serve+=(--tailscale)
  [ "$READ_ONLY" = 0 ] || serve+=(--read-only)
  [ "$DRY_RUN" = 0 ] || serve+=(--dry-run)
  step "the page on the host" "${serve[@]}"
fi
if [ "$DRY_RUN" = 1 ]; then
  log "dry run done: nothing was created, and the commands above are what a real run sends"
elif [ "$STEPS" = 4 ]; then
  log "done: the page is up on the host; the link above pairs your phone"
else
  again="$(dirname "$0")/deploy.sh"
  [ -z "$FID" ] || again="$again --fid $FID"
  [ "$ENV_FILE" = node.env ] || again="$again --env $ENV_FILE"
  [ "$FROM_SOURCE" = 0 ] || again="$again --from-source"
  log "done: ./bin/casty reads and writes through your node. To reach the page from any network: $again --domain <name>, or --tailscale"
fi
