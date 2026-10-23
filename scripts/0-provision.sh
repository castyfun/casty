#!/usr/bin/env bash
# Step 0 of 3: a host for a Snapchain read node (16 GB RAM, 2 TB disk, ports 3381-3383),
# rented from a cloud provider or one you already have. Writes node.env for step 1.
# shellcheck disable=SC2034 # HOST is read by the provider files, NODE_* by name in node_env_pairs
set -euo pipefail
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPTS/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: 0-provision.sh [--provider hetzner|aws|cherry|existing] [options]

  --provider <name>      hetzner, aws, cherry (dry run only for now) or existing; without it,
                         existing with --host, else the one whose credentials are set
  --name <name>          server name; also <name>-data and <name>-fw (default: fc-node)
  --region <region>      provider region (default: fsn1, us-east-1, eu_nord_1)
  --type <type>          server type (default: cpx41 then ccx23, cpx51; m6i.xlarge then m5.xlarge)
  --disk-gb <n>          data volume size, at least 2000 (default: 2000)
  --ssh-pubkey <file>    key to log in with (default: ~/.ssh/id_ed25519.pub)
  --allow-ip auto|<cidr> who may reach ssh, 3381 and 3383 (default: auto, your current IP)
  --https                also open 80 and 443 to everyone, for 1-node.sh serve --domain; a
                         rerun without it closes them again
  --host <user@ip>       the host, for --provider existing
  --dry-run              print every provider call instead of making it
  --destroy              delete the server, then its volume, then its firewall
  --yes                  do not ask before creating or deleting anything
  --json                 print node.env as JSON
  --out <file>           where to write node.env (default: node.env)

Exit codes: 0 ok, 2 bad arguments, 3 missing prerequisite, 4 provider error, 5 preflight failed.
USAGE
}

PROVIDER="" NAME="" REGION="" TYPE="" DISK_GB=2000 HOST="" ALLOW_IP=auto HTTPS=0
SSH_PUBKEY="$HOME/.ssh/id_ed25519.pub" DESTROY=0 YES=0 JSON=0 OUT=node.env
while [ $# -gt 0 ]; do
  case $1 in
    --provider | --name | --region | --type | --disk-gb | --ssh-pubkey | --allow-ip | --host | --out)
      [ $# -ge 2 ] || die "$EXIT_USAGE" "$1 needs a value"
      case $1 in
        --provider) PROVIDER=$2 ;;
        --name) NAME=$2 ;;
        --region) REGION=$2 ;;
        --type) TYPE=$2 ;;
        --disk-gb) DISK_GB=$2 ;;
        --ssh-pubkey) SSH_PUBKEY=$2 ;;
        --allow-ip) ALLOW_IP=$2 ;;
        --host) HOST=$2 ;;
        --out) OUT=$2 ;;
      esac
      shift
      ;;
    --dry-run) DRY_RUN=1 ;;
    --destroy) DESTROY=1 ;;
    --yes) YES=1 ;;
    --https) HTTPS=1 ;;
    --json) JSON=1 ;;
    -h | --help) usage && exit 0 ;;
    *) die "$EXIT_USAGE" "unknown argument $1 (see --help)" ;;
  esac
  shift
done

# A rerun works on the node node.env records, not on the defaults: a rerun in another AWS region
# or under another name would find nothing and build a second, billed node, and then replace the
# node.env that --destroy needs for the first. A dry run's placeholders record no node.
if [ -f "$OUT" ] && [ -n "$(env_value "$OUT" NODE_IP)" ] && [ "$(env_value "$OUT" NODE_CREATED_AT)" != dry-run ]; then
  for recorded in provider:NODE_PROVIDER:PROVIDER name:NODE_NAME:NAME region:NODE_REGION:REGION; do
    IFS=: read -r flag key var <<<"$recorded"
    was=$(env_value "$OUT" "$key")
    [ -n "$was" ] || continue
    [ -z "${!var}" ] || [ "${!var}" = "$was" ] ||
      die "$EXIT_USAGE" "$OUT describes the node made with --$flag $was, not ${!var}; for another node, pass --out <file>"
    printf -v "$var" '%s' "$was"
  done
  [ "$PROVIDER" != existing ] || [ -n "$HOST" ] || HOST="$(env_value "$OUT" NODE_USER)@$(env_value "$OUT" NODE_IP)"
fi
NAME=${NAME:-fc-node}

# No --provider: --host means an existing host, else the credentials already set say which.
if [ -z "$PROVIDER" ]; then
  found=""
  if [ -n "$HOST" ]; then
    found=existing
  else
    [ -z "${HCLOUD_TOKEN:-}" ] || found=hetzner
    if aws_credentials; then
      [ -z "$found" ] || die "$EXIT_USAGE" "both Hetzner and AWS credentials are set; pass --provider hetzner or --provider aws"
      found=aws
    fi
  fi
  [ -n "$found" ] || die "$EXIT_USAGE" "no provider: set HCLOUD_TOKEN for Hetzner or AWS credentials for AWS, or pass --host user@ip for a host you have (see --help)"
  PROVIDER=$found
  log "using $PROVIDER (pass --provider to choose another)"
fi

case $PROVIDER in
  hetzner | aws | cherry | existing) ;;
  *) die "$EXIT_USAGE" "unknown provider $PROVIDER; use hetzner, aws, cherry or existing" ;;
esac
case $DISK_GB in "" | *[!0-9]*) die "$EXIT_USAGE" "--disk-gb takes a whole number" ;; esac
# The preflight wants 1.8 TiB free; a smaller volume would be billed and then always fail it.
[ "$DISK_GB" -ge 2000 ] || die "$EXIT_USAGE" "--disk-gb must be at least 2000: the node needs about 1.8 TiB free"
case $NAME in "" | -* | *- | *[!a-z0-9-]*) die "$EXIT_USAGE" "--name may use lowercase letters, digits and dashes, and starts and ends with a letter or digit" ;; esac

# shellcheck source=lib/provider-hetzner.sh
. "$LIB_DIR/provider-$PROVIDER.sh"

# confirm <name> <prompt> <what happens otherwise>: stops unless the name is typed back. A
# closed stdin stops too, so nothing is created or deleted without someone at the keyboard.
confirm() {
  [ "$YES" = 1 ] && return
  printf '%s' "$2" >&2
  answer=""
  read -r answer || true
  [ "$answer" = "$1" ] || die "$EXIT_USAGE" "not confirmed, $3 (--yes skips this question)"
}
OUT_DIR=$(dirname "$OUT")
CLOUD_INIT="$OUT_DIR/$NAME.cloud-init.yaml"
# The node's own host keys, where 1-node.sh looks for them; --destroy removes them with node.env.
CASTY_KNOWN_HOSTS="${OUT%.env}.known_hosts"

if [ "$DESTROY" = 1 ]; then
  read_node_env "$OUT" || die "$EXIT_USAGE" "--destroy needs the $OUT written when the node was created"
  [ "$NODE_PROVIDER" = "$PROVIDER" ] ||
    die "$EXIT_USAGE" "$OUT describes a $NODE_PROVIDER node, not $PROVIDER; nothing was deleted"
  if [ "$DRY_RUN" = 1 ]; then
    provider_destroy
    log "dry run: nothing was deleted, $OUT is unchanged"
    exit 0
  fi
  provider_check
  confirm "$NODE_NAME" "This deletes $NODE_NAME, its data volume and its firewall. Type the name to confirm: " \
    "nothing was deleted"
  provider_destroy
  rm -f "$OUT" "$CASTY_KNOWN_HOSTS"
  log "deleted $NODE_NAME and removed $OUT"
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: printing provider calls, creating nothing; node.env gets placeholder values"
else
  provider_check
  [ -f "$SSH_PUBKEY" ] || die "$EXIT_PREREQ" "no SSH public key at $SSH_PUBKEY. Create one with ssh-keygen -t ed25519, or pass --ssh-pubkey."
fi

if [ "$ALLOW_IP" = auto ] && [ "$PROVIDER" != existing ]; then
  if [ "$DRY_RUN" = 1 ]; then
    run curl -s --max-time 10 https://api.ipify.org
    ALLOW_IP=203.0.113.10/32
  else
    ip=$(curl -s --max-time 10 https://api.ipify.org || true)
    case $ip in
      *[!0-9.]* | "") die "$EXIT_PREREQ" "could not learn your public IP from api.ipify.org; pass --allow-ip <cidr>" ;;
    esac
    ALLOW_IP="$ip/32"
  fi
fi
case $ALLOW_IP in */*) ;; *) [ "$PROVIDER" = existing ] || die "$EXIT_USAGE" "--allow-ip takes a CIDR such as 198.51.100.4/32" ;; esac

if [ "$DRY_RUN" != 1 ] && [ "$PROVIDER" != existing ]; then
  {
    echo "On $PROVIDER this creates, or reuses when they already exist under these names:"
    provider_plan
    echo "  volume    $NAME-data, $DISK_GB GB"
    echo "The server and the volume are billed until you run this again with --destroy."
  } >&2
  confirm "$NAME" "Type $NAME to create them: " "nothing was created"
fi

NODE_PROVIDER=$PROVIDER
NODE_NAME=$NAME
# By its absolute path: 1-node.sh may run from another directory.
case $SSH_PUBKEY in /*) ;; *) SSH_PUBKEY="$PWD/$SSH_PUBKEY" ;; esac
NODE_SSH_KEY=${SSH_PUBKEY%.pub}
NODE_DATA_DIR=/data
NODE_CREATED_AT=dry-run
if [ "$DRY_RUN" != 1 ]; then
  # A rerun keeps the first run's time, but never a dry run's placeholder: a real node recorded
  # as dry-run would be overwritten by the next dry run.
  NODE_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  created=""
  [ ! -f "$OUT" ] || created=$(env_value "$OUT" NODE_CREATED_AT)
  case $created in "" | dry-run) ;; *) NODE_CREATED_AT=$created ;; esac
fi
# Kept from the last run unless this one starts the server (started_now in the providers).
NODE_STARTED_AT=""
[ "$DRY_RUN" = 1 ] || [ ! -f "$OUT" ] || NODE_STARTED_AT=$(env_value "$OUT" NODE_STARTED_AT)

# A run that stops half way, by an error or a signal, still records what it made, so a rerun or
# --destroy can find it. It never replaces the node.env of a finished node (one with an IP). The
# trap is cleared once provider_up returns, so any exit it sees is a failure; $? cannot tell, as
# it is 0 after a signal that lands in a command substitution.
record_partial() {
  [ "$DRY_RUN" = 1 ] || [ "$PROVIDER" = existing ] && return
  [ -f "$OUT" ] && [ -n "$(env_value "$OUT" NODE_IP)" ] && return
  write_node_env "$OUT"
  log "$OUT records what was created so far: run the same command again to finish, or add --destroy"
}
NODE_REGION="" NODE_IP="" NODE_USER="" NODE_SERVER_ID="" NODE_VOLUME_ID=""
trap record_partial EXIT
provider_up
trap - EXIT
# A dry run writes placeholders, but never over the node.env of a real node.
if [ "$DRY_RUN" = 1 ] && [ -f "$OUT" ] && [ "$(env_value "$OUT" NODE_CREATED_AT)" != dry-run ]; then
  log "dry run: kept the existing $OUT, which describes a real node"
else
  write_node_env "$OUT"
  log "wrote $OUT ($NODE_PROVIDER, $NODE_USER@$NODE_IP)"
fi
[ "$JSON" = 1 ] && node_env_json
next="$(dirname "$0")/1-node.sh"
[ "$OUT" = node.env ] || next="$next --env $OUT"
# A dry run's node.env describes no server; 1-node.sh takes it only for another dry run.
[ "$DRY_RUN" = 0 ] || next="$next --dry-run"
log "next: $next"
