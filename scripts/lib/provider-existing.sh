# shellcheck shell=bash disable=SC2034 # NODE_* are written to node.env by 0-provision.sh
# A host you already have (a home server, another cloud): nothing is created, the host is
# checked over ssh. Sourced by 0-provision.sh, which sets HOST.

provider_check() {
  require_cmd ssh "Install OpenSSH."
}

provider_up() {
  case $HOST in
    ?*@?*) ;;
    "") die "$EXIT_USAGE" "--provider existing needs --host user@ip" ;;
    *) die "$EXIT_USAGE" "--host must look like user@ip, not $HOST" ;;
  esac
  NODE_USER=${HOST%%@*}
  NODE_IP=${HOST#*@}
  check_ssh_name "the user in --host" "$NODE_USER"
  check_ssh_name "the host in --host" "$NODE_IP"
  NODE_SERVER_ID=existing
  NODE_VOLUME_ID=none
  NODE_REGION=""
  # Relative to the remote home: ~/snapchain lives wherever the home directory is.
  NODE_DATA_DIR=.
  log "checking $HOST"
  preflight "$HOST" "$NODE_SSH_KEY" "$NODE_DATA_DIR" ||
    die "$EXIT_PREFLIGHT" "$HOST does not meet the requirements above"
}

provider_destroy() {
  die "$EXIT_USAGE" "--destroy does not apply to --provider existing: nothing was created"
}
