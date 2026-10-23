# shellcheck shell=bash disable=SC2034 # the constants here are read by the scripts that source it
# Helpers shared by the casty scripts: logging, exit codes, dry-run plumbing, templates, ssh.
# Sourced, never run. Works with the bash 3.2 that ships with macOS.

# Raw files of Snapchain releases, under a tag: @latest moves to every release, v<version>
# stays put. The Snapchain docs fetch docker-compose.testnet.yml with this same URL form.
SNAPCHAIN_RAW="https://raw.githubusercontent.com/farcasterxyz/snapchain"
SNAPCHAIN_IMAGE=farcasterxyz/snapchain

# pruning.block_retention is written as <days> followed by this suffix.
BLOCK_RETENTION_SUFFIX="d"

LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATES_DIR="$LIB_DIR/../templates"
DRY_RUN=${DRY_RUN:-0}

# Exit codes shared by the scripts.
EXIT_USAGE=2
EXIT_PREREQ=3
EXIT_PROVIDER=4
EXIT_PREFLIGHT=5

# DRY: lines go to the original stdout even when `run` is called inside $(...).
exec 3>&1

log() { printf '%s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }

# die <exit code> <message>
die() {
  local code=$1
  shift
  printf 'error: %s\n' "$*" >&2
  exit "$code"
}

# require_cmd <command> <how to install it>
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$EXIT_PREREQ" "$1 is not installed. $2"
}

# require_env <variable> <how to get it>
require_env() {
  [ -n "${!1:-}" ] || die "$EXIT_PREREQ" "$1 is not set. $2"
}

# Arguments joined for display, single-quoting the ones the shell would split or expand.
quote() {
  local arg out="" quote="'" escaped="'\\''"
  for arg in "$@"; do
    case $arg in
      "" | *[!A-Za-z0-9_./:=@,+%-]*) arg="'${arg//$quote/$escaped}'" ;;
    esac
    out="${out:+$out }$arg"
  done
  printf '%s' "$out"
}

# run <command...>: runs it, or with --dry-run prints "DRY: <command>" instead.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY: %s\n' "$(quote "$@")" >&3
  else
    "$@"
  fi
}

# run_with_input <file> <command...>: like run, with <file> on stdin.
run_with_input() {
  local input=$1
  shift
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY: %s < %s\n' "$(quote "$@")" "$input" >&3
  else
    "$@" <"$input"
  fi
}

# render <template> [NAME=value...]: replaces each {{NAME}} in the template with value.
render() {
  local text pair name value
  text=$(<"$1")
  shift
  for pair in "$@"; do
    name=${pair%%=*}
    value=${pair#*=}
    text=${text//"{{$name}}"/"$value"}
  done
  printf '%s\n' "$text"
}

# A random alphanumeric string of the given length (up to about 40). It reads a fixed 256 bytes,
# so no writer is cut off by SIGPIPE, which pipefail would turn into exit status 141.
random_token() {
  head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-"$1"
}

# The sha256 of stdin as 64 hex digits, with whichever tool the machine has.
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi
}

# ssh_opts <private key>: sets SSH_OPTS, the options of every connection: never prompt, offer
# only this key, trust a new host key once. With CASTY_KNOWN_HOSTS set (the node's own file next
# to node.env), host keys are kept there, so a server rebuilt on the same IP needs no edit of
# ~/.ssh/known_hosts. ssh splits that value on spaces unless it is double-quoted. Also makes
# sure ~/.ssh, where the control sockets go, exists.
ssh_opts() {
  SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o IdentitiesOnly=yes)
  [ -z "${CASTY_KNOWN_HOSTS:-}" ] || SSH_OPTS+=(-o "UserKnownHostsFile=\"$CASTY_KNOWN_HOSTS\"")
  SSH_OPTS+=(-i "$1")
  [ "$DRY_RUN" = 1 ] || [ -d "$HOME/.ssh" ] || mkdir -m 700 "$HOME/.ssh"
}

# The commands a run sends to a host share one connection: the first ssh becomes a master that
# stays 120 s after the last, so `1-node.sh up` logs in once instead of for every command, and
# `status --wait`, which checks at most 60 s apart (POLL_MAX), keeps the same login for hours.
# The tunnel has a socket of its own.
SSH_SHARED=(-o ControlMaster=auto -o ControlPersist=120 -o "ControlPath=\"$HOME/.ssh/casty-%C\"")

# remote <user@host> <private key> <command...>: runs a command on the host, stdin closed.
remote() {
  local host=$1 key=$2
  shift 2
  ssh_opts "$key"
  run ssh -n "${SSH_OPTS[@]}" "${SSH_SHARED[@]}" "$host" "$@"
}

# remote_with_input <file> <user@host> <private key> <command...>: same, with <file> on stdin.
remote_with_input() {
  local input=$1 host=$2 key=$3
  shift 3
  ssh_opts "$key"
  run_with_input "$input" ssh "${SSH_OPTS[@]}" "${SSH_SHARED[@]}" "$host" "$@"
}

# preflight <user@host> <private key> <data dir>: checks the host; exit status 5 on failure.
# CASTY_MIN_FREE_GIB, when set, replaces the 1.8 TiB the disk check asks for.
preflight() {
  local now=NOW
  [ "$DRY_RUN" = 1 ] || now=$(date +%s)
  [[ ${CASTY_MIN_FREE_GIB:-} =~ ^([1-9][0-9]*)?$ ]] || die "$EXIT_USAGE" "CASTY_MIN_FREE_GIB takes a whole number of GiB"
  # ssh joins its arguments into one line for the remote shell, so the directory goes quoted.
  # ssh's own failures are 255, which the checks never are.
  remote_with_input "$LIB_DIR/preflight.sh" "$1" "$2" bash -s -- "$(quote "$3")" "$now" ${CASTY_MIN_FREE_GIB:+"$CASTY_MIN_FREE_GIB"} || {
    local code=$?
    [ "$code" != 255 ] || die "$EXIT_PROVIDER" "no ssh connection to $1: check the address, the key and that the firewall lets you in"
    return "$code"
  }
}

# aws_credentials: true when the aws CLI has something to sign in with: keys or a profile in the
# environment, or its credentials or config file (which holds SSO and assumed-role profiles).
aws_credentials() {
  [ -n "${AWS_ACCESS_KEY_ID:-}${AWS_PROFILE:-}" ] ||
    [ -f "${AWS_SHARED_CREDENTIALS_FILE:-$HOME/.aws/credentials}" ] ||
    [ -f "${AWS_CONFIG_FILE:-$HOME/.aws/config}" ]
}

# The node.env keys, in file order.
NODE_KEYS="NODE_PROVIDER NODE_NAME NODE_REGION NODE_IP NODE_USER NODE_SSH_KEY NODE_SERVER_ID NODE_VOLUME_ID NODE_DATA_DIR NODE_CREATED_AT NODE_STARTED_AT"

# started_now: records in NODE_STARTED_AT that this run created, started or powered on the
# server, so 1-node.sh gives it the time a boot takes.
started_now() {
  if [ "$DRY_RUN" = 1 ]; then NODE_STARTED_AT=dry-run; else NODE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ); fi
}

# node_env_pairs: the NODE_* variables as KEY=value lines, in node.env order.
node_env_pairs() {
  local key
  for key in $NODE_KEYS; do printf '%s=%s\n' "$key" "${!key:-}"; done
}

write_node_env() {
  node_env_pairs >"$1"
}

# env_value <file> <key>: the last value of key in a KEY=value file.
env_value() {
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# read_node_env <file>: sets the NODE_* variables. Parsed, not sourced, so it never runs code.
read_node_env() {
  local key
  [ -f "$1" ] || return 1
  for key in $NODE_KEYS; do printf -v "$key" '%s' "$(env_value "$1" "$key")"; done
  check_ssh_name "NODE_USER in $1" "$NODE_USER"
  check_ssh_name "NODE_IP in $1" "$NODE_IP"
}

# check_ssh_name <what> <user or host>: dies unless ssh can only read it as a user or a host.
# A value starting with - would be taken for an option (-oProxyCommand=... runs a command
# here), and anything beyond letters, digits and . _ : - has no place in a user, an IP or a
# host name. Empty passes: callers that need a value check for it.
check_ssh_name() {
  case $2 in
    -* | *[!A-Za-z0-9._:-]*) die "$EXIT_USAGE" "$1 may use only letters, digits and . _ : - and not start with -, not $2" ;;
  esac
}

# node_env_json: the NODE_* variables as one JSON object.
node_env_json() {
  local line value out=""
  while IFS= read -r line; do
    value=${line#*=}
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    out="${out:+$out,}\"${line%%=*}\":\"$value\""
  done < <(node_env_pairs)
  printf '{%s}\n' "$out"
}
