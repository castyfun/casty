# shellcheck shell=bash disable=SC2034 # NODE_* are written to node.env by 0-provision.sh
# Hetzner Cloud through the hcloud CLI. Sourced by 0-provision.sh, which sets NAME, REGION,
# TYPE, DISK_GB, SSH_PUBKEY, ALLOW_IP, OUT_DIR and CLOUD_INIT.

HETZNER_TYPES="cpx41 ccx23 cpx51"
HETZNER_IMAGE=ubuntu-24.04
HETZNER_LOCATION=fsn1

provider_check() {
  require_cmd hcloud "Install it: https://github.com/hetznercloud/cli#installation"
  require_env HCLOUD_TOKEN "Create a read/write API token in the Hetzner Cloud console (project > Security > API tokens)."
}

provider_plan() {
  echo "  server    $NAME: ${TYPE:-$HETZNER_TYPES} (the first one available), $HETZNER_IMAGE, ${REGION:-$HETZNER_LOCATION}"
  echo "  firewall  $NAME-fw: ssh, 3381 and 3383 from $ALLOW_IP; gossip 3382 from anywhere$([ "$HTTPS" = 0 ] || echo '; 80 and 443 from anywhere')"
}

# hcloud_exists <kind> <name>. A dry run assumes nothing exists yet. The list is captured and
# read line by line: piped into grep -q under pipefail, an early match can SIGPIPE the writer
# and report a name that is there as missing.
hcloud_exists() {
  local names line
  if [ "$DRY_RUN" = 1 ]; then
    run hcloud "$1" list -o noheader -o columns=name
    return 1
  fi
  names=$(hcloud "$1" list -o noheader -o columns=name) || die "$EXIT_PROVIDER" "hcloud $1 list failed"
  while IFS= read -r line; do
    [ "$line" = "$2" ] && return 0
  done <<<"$names"
  return 1
}

# The name of the project's SSH key for $SSH_PUBKEY, uploading it as $NAME if it is not there.
# Hetzner refuses a second copy of a key, so a key uploaded earlier under any name is reused.
hetzner_ssh_key() {
  local fingerprint keys key_name key_fingerprint
  if [ "$DRY_RUN" = 1 ]; then
    run hcloud ssh-key list -o noheader -o columns=fingerprint,name
    run hcloud ssh-key create --name "$NAME" --public-key-from-file "$SSH_PUBKEY"
    echo "$NAME"
    return
  fi
  fingerprint=$(ssh-keygen -l -E md5 -f "$SSH_PUBKEY" | awk '{ print $2 }')
  fingerprint=${fingerprint#MD5:}
  # The fingerprint comes first because a name may hold spaces: read gives the last field the
  # rest of the line.
  keys=$(hcloud ssh-key list -o noheader -o columns=fingerprint,name) || die "$EXIT_PROVIDER" "hcloud ssh-key list failed"
  while read -r key_fingerprint key_name; do
    [ "$key_fingerprint" != "$fingerprint" ] || { echo "$key_name" && return; }
  done <<<"$keys"
  while read -r _ key_name; do
    [ "$key_name" != "$NAME" ] ||
      die "$EXIT_PROVIDER" "the project has a different SSH key named $NAME; pass another --name or --ssh-pubkey"
  done <<<"$keys"
  hcloud ssh-key create --name "$NAME" --public-key-from-file "$SSH_PUBKEY" >&2 ||
    die "$EXIT_PROVIDER" "hcloud ssh-key create failed"
  echo "$NAME"
}

# hcloud_get <kind> <name> <Go template> <dry-run placeholder>. Called as $(...): die ends the
# subshell, and the caller's assignment then stops the run with the same exit code.
hcloud_get() {
  if [ "$DRY_RUN" = 1 ]; then
    run hcloud "$1" describe "$2" -o "format=$3"
    echo "$4"
  else
    hcloud "$1" describe "$2" -o "format=$3" || die "$EXIT_PROVIDER" "hcloud $1 describe $2 failed"
  fi
}

# SSH and the node's APIs from --allow-ip only; gossip (3382) from anywhere so peers can connect;
# with --https, 80 and 443 from anywhere, for the casty page and its certificate.
hetzner_rules() {
  local extra=""
  [ "$HTTPS" = 0 ] || extra=',
  {"description": "casty https", "direction": "in", "protocol": "tcp", "port": "80", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"description": "casty https", "direction": "in", "protocol": "tcp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"]}'
  cat <<JSON
[
  {"description": "ssh", "direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["$ALLOW_IP"]},
  {"description": "snapchain http", "direction": "in", "protocol": "tcp", "port": "3381", "source_ips": ["$ALLOW_IP"]},
  {"description": "snapchain gossip", "direction": "in", "protocol": "udp", "port": "3382", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"description": "snapchain gossip", "direction": "in", "protocol": "tcp", "port": "3382", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"description": "snapchain grpc", "direction": "in", "protocol": "tcp", "port": "3383", "source_ips": ["$ALLOW_IP"]}$extra
]
JSON
}

provider_up() {
  local location=${REGION:-$HETZNER_LOCATION} rules="$OUT_DIR/$NAME.firewall.json" type created="" key server
  NODE_REGION=$location

  key=$(hetzner_ssh_key)
  hetzner_rules >"$rules"
  if ! hcloud_exists firewall "$NAME-fw"; then
    run hcloud firewall create --name "$NAME-fw" --rules-file "$rules" || die "$EXIT_PROVIDER" "hcloud firewall create failed"
  else
    # A rerun from another network moves SSH and the node's APIs to the current --allow-ip.
    run hcloud firewall replace-rules "$NAME-fw" --rules-file "$rules" ||
      die "$EXIT_PROVIDER" "hcloud firewall replace-rules failed"
  fi
  hcloud_exists volume "$NAME-data" ||
    run hcloud volume create --name "$NAME-data" --size "$DISK_GB" --location "$location" --format ext4 ||
    die "$EXIT_PROVIDER" "hcloud volume create failed"
  NODE_VOLUME_ID=$(hcloud_get volume "$NAME-data" '{{.ID}}' dry-run-volume)

  if ! hcloud_exists server "$NAME"; then
    render "$TEMPLATES_DIR/cloud-init.yaml.tmpl" NAME="$NAME" USER=root HOME=/root \
      DATA_DEVICE="/dev/disk/by-id/scsi-0HC_Volume_$NODE_VOLUME_ID" >"$CLOUD_INIT"
    for type in ${TYPE:-$HETZNER_TYPES}; do
      if run hcloud server create --name "$NAME" --type "$type" --image "$HETZNER_IMAGE" --location "$location" \
        --ssh-key "$key" --firewall "$NAME-fw" --volume "$NAME-data" --user-data-from-file "$CLOUD_INIT"; then
        created=$type
        started_now
        break
      fi
      warn "could not create a $type server in $location; trying the next type"
    done
    [ -n "$created" ] || die "$EXIT_PROVIDER" "none of ${TYPE:-$HETZNER_TYPES} could be created in $location"
  fi
  # One describe for all three: a failure still stops the run in this assignment. A server found
  # off (powered down in the console) is powered on.
  server=$(hcloud_get server "$NAME" '{{.ID}} {{.PublicNet.IPv4.IP}} {{.Status}}' 'dry-run 192.0.2.1 running')
  read -r NODE_SERVER_ID NODE_IP status <<<"$server"
  if [ "$status" = off ]; then
    run hcloud server poweron "$NAME" || die "$EXIT_PROVIDER" "hcloud server poweron failed"
    started_now
  fi
  NODE_USER=root
}

# hcloud_delete <kind> <name>, skipping what is not there: a run that stopped half way made
# only some of the three.
hcloud_delete() {
  [ "$DRY_RUN" = 1 ] || hcloud_exists "$1" "$2" || return 0
  run hcloud "$1" delete "$2" && return 0
  # A volume stays attached a little while after its server is deleted, and cannot be deleted
  # until it is let go: up to a minute more. HCLOUD_RETRY_SLEEP (seconds) tunes it for tests.
  local attempt
  if [ "$1" = volume ]; then
    for attempt in 1 2 3 4 5 6; do
      sleep "${HCLOUD_RETRY_SLEEP:-10}"
      run hcloud "$1" delete "$2" && return 0
    done
  fi
  die "$EXIT_PROVIDER" "hcloud $1 delete failed"
}

provider_destroy() {
  hcloud_delete server "$NODE_NAME"
  hcloud_delete volume "$NODE_NAME-data"
  hcloud_delete firewall "$NODE_NAME-fw"
}
