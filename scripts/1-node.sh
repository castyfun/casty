#!/usr/bin/env bash
# Step 1 of 3: a Snapchain read node on the host from step 0, synced, with an SSH tunnel so
# http://127.0.0.1:3381 on this machine reaches it.
set -euo pipefail
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPTS/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: 1-node.sh [up|status|logs|tunnel|upgrade|serve|down] [options]

  (no command)            up, wait for sync, then open the tunnel
  up                      check the host, write ~/snapchain, start the node, wait for sync
  status [--wait]         sync progress per shard; --wait polls until synced
  logs [casty]            follow the node's logs, or the casty service's
  tunnel [--stop]         forward local ports 3381 and 3383 to the node over SSH
  upgrade                 fetch the latest release's compose file (or --release) and restart
  serve                   run casty on the host, reached over HTTPS from any network: needs
                          --domain <name> (Caddy gets the certificate; open 80 and 443 with
                          0-provision.sh --https) or --tailscale (tailscale serve on the host)
  down                    stop the node, and casty if it serves

  --fid <fid>             your fid, recorded as HUB_OPERATOR_FID (default: 0)
  --autoupgrade           install snapchain.sh's weekly auto-upgrade (needs --fid). It runs
                          docker system prune --volumes -f on the whole host.
  --block-retention <n>   prune blocks older than n days (read nodes only)
  --release <version>     run this Snapchain release, such as 0.14.3, instead of the latest
  --no-tunnel             do not open the tunnel after sync
  --timeout <seconds>     how long status --wait waits (default: 43200, 12 hours)
  --env <file>            node.env from step 0 (default: node.env)
  --dry-run               print the ssh commands instead of running them
  serve:
  --domain <name>         the name the page is reached at; must point at the host
  --tailscale             reach it as the host's name on your tailnet instead
  --read-only             a page that reads only: no app key or passphrase leaves this machine
  --config <dir>          casty's config directory here (default: $XDG_CONFIG_HOME/casty)

Exit codes: 0 ok, 1 not synced or the node did not answer, 2 bad arguments, 3 missing prerequisite,
4 no ssh connection or download failed, 5 preflight failed.
USAGE
}

COMMAND="" FID="" AUTOUPGRADE=0 RETENTION="" RELEASE="" TUNNEL=1 ENV_FILE=node.env WAIT=0 TIMEOUT=43200 STOP=0
DOMAIN="" TAILSCALE=0 READ_ONLY=0 CONFIG_DIR="" SERVICE=snapchain
while [ $# -gt 0 ]; do
  case $1 in
    up | status | logs | tunnel | upgrade | serve | down) COMMAND=$1 ;;
    casty) [ "$COMMAND" = logs ] || die "$EXIT_USAGE" "unknown argument $1 (see --help)" && SERVICE=casty ;;
    --fid | --block-retention | --release | --env | --timeout | --domain | --config)
      [ $# -ge 2 ] || die "$EXIT_USAGE" "$1 needs a value"
      case $1 in
        --fid) FID=$2 ;;
        --block-retention) RETENTION=$2 ;;
        --release) RELEASE=$2 ;;
        --env) ENV_FILE=$2 ;;
        --timeout) TIMEOUT=$2 ;;
        --domain) DOMAIN=$2 ;;
        --config) CONFIG_DIR=$2 ;;
      esac
      shift
      ;;
    --autoupgrade) AUTOUPGRADE=1 ;;
    --no-tunnel) TUNNEL=0 ;;
    --wait) WAIT=1 ;;
    --stop) STOP=1 ;;
    --tailscale) TAILSCALE=1 ;;
    --read-only) READ_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage && exit 0 ;;
    *) die "$EXIT_USAGE" "unknown argument $1 (see --help)" ;;
  esac
  shift
done
for number in "$FID" "$RETENTION" "$TIMEOUT"; do
  case $number in *[!0-9]*) die "$EXIT_USAGE" "--fid, --block-retention and --timeout take whole numbers" ;; esac
done
case $RELEASE in
  *[!0-9.]* | .* | *.) die "$EXIT_USAGE" "--release takes a version such as 0.14.3" ;;
esac
[ -z "$RELEASE" ] || [ "$AUTOUPGRADE" = 0 ] ||
  die "$EXIT_USAGE" "--release pins a version and --autoupgrade would replace it; pick one"
# The domain lands in a Caddyfile and a compose file: letters, digits, dots and dashes only.
case $DOMAIN in *[!A-Za-z0-9.-]* | -* | .*) die "$EXIT_USAGE" "--domain takes a host name such as node.example.org" ;; esac
if [ "$COMMAND" = serve ]; then
  [ -n "$DOMAIN" ] || [ "$TAILSCALE" = 1 ] || die "$EXIT_USAGE" "serve needs --domain <name> or --tailscale (see --help)"
  [ -z "$DOMAIN" ] || [ "$TAILSCALE" = 0 ] || die "$EXIT_USAGE" "--domain and --tailscale are two ways to reach the page; pick one"
fi

read_node_env "$ENV_FILE" || die "$EXIT_USAGE" "no $ENV_FILE; run ./scripts/0-provision.sh first, or pass --env"
[ -n "$NODE_IP" ] || die "$EXIT_USAGE" "$ENV_FILE has no NODE_IP: provisioning stopped half way; run ./scripts/0-provision.sh again"
[ "$NODE_CREATED_AT" != dry-run ] || [ "$DRY_RUN" = 1 ] ||
  die "$EXIT_USAGE" "$ENV_FILE is from a dry run and describes no server: run ./scripts/0-provision.sh without --dry-run, or add --dry-run here"
HOST="$NODE_USER@$NODE_IP"
# This node's host keys, next to node.env; node-status.sh's ssh calls read it from the environment.
export CASTY_KNOWN_HOSTS="${ENV_FILE%.env}.known_hosts"
AGAIN="$(dirname "$0")/1-node.sh"
[ "$ENV_FILE" = node.env ] || AGAIN="$AGAIN --env $ENV_FILE"
KEY=$NODE_SSH_KEY
[ "$DRY_RUN" = 1 ] || [ -f "$KEY" ] ||
  die "$EXIT_PREREQ" "no SSH private key at $KEY (NODE_SSH_KEY in $ENV_FILE); put it back, or correct the path"
# The sync status is read with jq here, after the node has started: missing, it is said first.
case $COMMAND in
  "" | up | status | serve) [ "$DRY_RUN" = 1 ] || require_cmd jq "Install it with your package manager (apt install jq, brew install jq)." ;;
esac
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

on() { remote "$HOST" "$KEY" "$@"; }

# A server step 0 created or started in the last 15 minutes may still be booting: up to 60
# tries, about twenty minutes at worst. One made before has booted long ago, and 6 tries tell
# it is not answering (a changed address, a firewall that no longer lets this one in, a
# stopped server).
ssh_tries() {
  local before=$(($(date +%s) - 900)) cutoff
  cutoff=$(date -u -d "@$before" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$before" +%Y-%m-%dT%H:%M:%SZ)
  if [[ $NODE_CREATED_AT > $cutoff || $NODE_STARTED_AT > $cutoff ]]; then echo 60; else echo 6; fi
}

# A server step 0 just created answers ssh only after it has booted and cloud-init has
# installed the key. SSH_RETRIES and SSH_RETRY_SLEEP (seconds) tune the wait; tests shorten it.
# A changed host key stops at once: waiting does not change it. ssh's messages go to a file, not
# to a pipe, which a persisting ssh master could hold open.
wait_for_ssh() {
  local attempt error
  for attempt in $(seq "${SSH_RETRIES:-$(ssh_tries)}"); do
    on true 2>"$WORK/ssh.err" >/dev/null && return 0
    grep -q "Host key verification failed" "$WORK/ssh.err" &&
      die "$EXIT_PROVIDER" "the host key of $HOST is not the one in $CASTY_KNOWN_HOSTS. If the server was rebuilt, delete that file and run again; if not, find out why first."
    [ "$attempt" != 1 ] || log "waiting for ssh on $HOST (a new server takes a minute or two)"
    sleep "${SSH_RETRY_SLEEP:-5}"
  done
  error=$(cat "$WORK/ssh.err")
  die "$EXIT_PROVIDER" "no ssh connection to $HOST: ${error:-no answer}. Check NODE_IP and NODE_SSH_KEY in $ENV_FILE, and that the firewall lets your address in (0-provision.sh --allow-ip)."
}

write_env() {
  local skip="SKIP_CRONTAB=true"
  [ "$AUTOUPGRADE" = 0 ] || skip=""
  render "$TEMPLATES_DIR/snapchain.env.tmpl" FID="${FID:-0}" SKIP_CRONTAB="$skip" \
    GRAFANA_PASSWORD="$(random_token 16)" >"$WORK/snapchain.env"
  # Append only the keys .env does not have yet; never change a value that is already there.
  # shellcheck disable=SC2016 # expanded by the remote shell
  remote_with_input "$WORK/snapchain.env" "$HOST" "$KEY" 'mkdir -p ~/snapchain && cd ~/snapchain &&
    touch .env && chmod 600 .env && { [ -z "$(tail -c 1 .env)" ] || echo >>.env; } &&
    while IFS= read -r line; do
      case $line in "" | "#"*) continue ;; esac
      grep -q "^${line%%=*}=" .env || printf "%s\n" "$line" >>.env
    done'
}

# A release's compose file still names the :latest image, so --release pins the image too,
# and stops if the file no longer names it that way. A weekly auto-upgrade would undo the pin,
# so --release removes it.
# Grafana's files come along, as snapchain.sh fetches them: the compose file bind-mounts
# grafana.ini, and Docker puts a directory where a missing file should be, so `docker compose up
# -d grafana` would fail. Its data directory is made writable for Grafana's own user, as
# snapchain.sh does; the datasource and the dashboard are provisioned from files, which
# snapchain.sh upgrade would do through Grafana's API instead.
fetch_release() {
  local raw="$SNAPCHAIN_RAW/@latest" removed
  [ -z "$RELEASE" ] || raw="$SNAPCHAIN_RAW/v$RELEASE"
  on "cd ~/snapchain && mkdir -p grafana/data grafana/provisioning/datasources grafana/provisioning/dashboards &&
    chmod 777 grafana/data &&
    curl -fsSL -o docker-compose.yml $raw/docker-compose.mainnet.yml &&
    curl -fsSL -o validators.toml $raw/validators.toml &&
    curl -fsSL -o grafana/grafana.ini $raw/grafana/grafana.ini &&
    curl -fsSL -o grafana/provisioning/dashboards/snapchain.json $raw/grafana/grafana-dashboard.json" ||
    die "$EXIT_PROVIDER" "could not download Snapchain's compose file, validators.toml and Grafana files from $raw"
  remote_with_input "$TEMPLATES_DIR/grafana-datasource.yaml" "$HOST" "$KEY" 'cat >~/snapchain/grafana/provisioning/datasources/graphite.yaml'
  remote_with_input "$TEMPLATES_DIR/grafana-dashboards.yaml" "$HOST" "$KEY" 'cat >~/snapchain/grafana/provisioning/dashboards/snapchain.yaml'
  [ -n "$RELEASE" ] || return 0
  on "cd ~/snapchain && sed -i.orig 's#image: $SNAPCHAIN_IMAGE:latest#image: $SNAPCHAIN_IMAGE:$RELEASE#' docker-compose.yml &&
    grep -q 'image: $SNAPCHAIN_IMAGE:$RELEASE' docker-compose.yml" ||
    die "$EXIT_PROVIDER" "Snapchain $RELEASE's docker-compose.yml does not name $SNAPCHAIN_IMAGE:latest, so it cannot be pinned"
  # One call removes the cron line, if there is one, and says whether it did.
  removed=$(on "if crontab -l 2>/dev/null | grep -q 'snapchain.sh autoupgrade'; then
      crontab -l | grep -v 'snapchain.sh autoupgrade' | crontab - && echo removed; fi") ||
    die "$EXIT_PROVIDER" "could not remove the weekly auto-upgrade from the crontab on $HOST"
  [ -z "$removed" ] || warn "removed the weekly auto-upgrade, which would replace Snapchain $RELEASE"
}

write_override() {
  local service=""
  [ -z "$RETENTION" ] || service=$(printf '  snapchain:\n    environment:\n      SNAPCHAIN_PRUNING__BLOCK_RETENTION: "%s%s"' \
    "$RETENTION" "$BLOCK_RETENTION_SUFFIX")
  render "$TEMPLATES_DIR/docker-compose.override.yml.tmpl" SNAPCHAIN_SERVICE="$service" >"$WORK/override.yml"
  remote_with_input "$WORK/override.yml" "$HOST" "$KEY" 'cat >~/snapchain/docker-compose.override.yml'
}

# The same weekday snapchain.sh would pick for this fid; the hour comes from the same hash.
install_autoupgrade() {
  local hash day hour
  hash=$(printf '%s' "$FID" | sha256_hex)
  day=$((0x${hash:0:8} % 5 + 1))
  hour=$((0x${hash:8:8} % 7))
  warn "auto-upgrade runs docker system prune --volumes -f on this host every week"
  on "cd ~/snapchain && curl -fsSL -o snapchain.sh $SNAPCHAIN_RAW/@latest/scripts/snapchain.sh && chmod +x snapchain.sh &&
    (crontab -l 2>/dev/null | grep -v 'snapchain.sh autoupgrade';
     echo \"0 $hour * * $day \$HOME/snapchain/snapchain.sh autoupgrade >> \$HOME/snapchain/snapchain-autoupgrade.log 2>&1\") | crontab -"
}

# The laptop's casty config directory, as casty itself finds it.
casty_config_dir() {
  if [ -n "$CONFIG_DIR" ]; then printf '%s\n' "$CONFIG_DIR"; else printf '%s/casty\n' "${XDG_CONFIG_HOME:-$HOME/.config}"; fi
}

# The key store passphrase, from CASTY_PASSPHRASE or a hidden prompt, into PASSPHRASE. It goes
# to the host as a docker secret, never onto the command line or into a log.
read_passphrase() {
  PASSPHRASE=${CASTY_PASSPHRASE:-}
  [ -z "$PASSPHRASE" ] || return 0
  [ -t 0 ] || die "$EXIT_PREREQ" "no terminal to ask the key store passphrase on; set CASTY_PASSPHRASE for this run"
  read -rs -p "key store passphrase (the one casty init set): " PASSPHRASE </dev/tty
  echo >&2
  [ -n "$PASSPHRASE" ] || die "$EXIT_PREREQ" "the passphrase is empty"
}

# What the Dockerfile builds from: the client's source and what pnpm needs for the lockfile,
# never node_modules, tests or dist.
pack_source() {
  # No extended attributes: macOS adds some to every file, which GNU tar on the host would
  # mention one by one.
  (cd "$SCRIPTS/.." && tar --no-xattrs -cf "$WORK/src.tar" package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json \
    client/package.json client/build.mjs client/tsconfig.json client/src test/mock-node/package.json docs/package.json)
}

# casty on the host, beside the node, as a container built from this checkout; the page is
# reached as https://<domain> through Caddy, or as the host's tailnet name through tailscale
# serve. The key store and its passphrase go to the host only with --read-only left out.
cmd_serve() {
  local dir front="" public_host token="" attempt read_only=""
  dir=$(casty_config_dir)
  # A dry run prints the commands all the same: deploy.sh --dry-run gets here with the client
  # skipped, so before casty has a config.
  need() {
    [ "$DRY_RUN" = 1 ] || die "$EXIT_PREREQ" "$1"
    warn "$1 (a real run stops here)"
  }
  [ -f "$dir/config.json" ] ||
    need "no casty config in $dir: run ./scripts/2-client.sh (casty init) first, or pass --config <dir>"
  if [ "$READ_ONLY" = 1 ]; then
    PASSPHRASE="" read_only=', "--read-only"'
  else
    [ -f "$dir/keys.enc.json" ] ||
      need "no keys.enc.json in $dir: add an app key first (./bin/casty web, under you, \"add a key with your wallet\", or casty init), or pass --read-only for a page that reads only"
    if [ "$DRY_RUN" = 1 ]; then PASSPHRASE=""; else read_passphrase; fi
  fi
  if [ "$TAILSCALE" = 1 ]; then
    public_host=$(on "tailscale status --json" | jq -r '.Self.DNSName // empty' | sed 's/\.$//')
    if [ -z "$public_host" ] && [ "$DRY_RUN" = 1 ]; then
      public_host=TAILNET_NAME
    elif [ -z "$public_host" ]; then
      die "$EXIT_PROVIDER" "tailscale on $HOST reports no name for it: install tailscale there and log it in first"
    fi
    front=$(printf '    ports:\n      - "127.0.0.1:3390:3390"')
  else
    public_host=$DOMAIN
    # No 443/udp: the firewall opens tcp only, and a phone would try HTTP/3 first and wait.
    front=$(printf '  caddy:\n    image: caddy:2-alpine\n    restart: unless-stopped\n    networks: [snapchain]\n    ports:\n      - "80:80"\n      - "443:443"\n    volumes:\n      - ./casty/Caddyfile:/etc/caddy/Caddyfile:ro\n      - caddy_data:/data\n      - caddy_config:/config\nvolumes:\n  caddy_data:\n  caddy_config:')
  fi

  log "writing ~/snapchain/casty on $HOST"
  pack_source
  # shellcheck disable=SC2016 # expanded by the remote shell
  remote_with_input "$WORK/src.tar" "$HOST" "$KEY" 'rm -rf ~/snapchain/casty/src && mkdir -p ~/snapchain/casty/src ~/snapchain/casty/config && tar -xf - -C ~/snapchain/casty/src'
  # In the build context, where compose looks for it.
  remote_with_input "$TEMPLATES_DIR/casty.Dockerfile.tmpl" "$HOST" "$KEY" 'cat >~/snapchain/casty/src/Dockerfile'
  remote_with_input "$dir/config.json" "$HOST" "$KEY" 'cat >~/snapchain/casty/config/config.json'
  if [ "$READ_ONLY" = 0 ]; then
    remote_with_input "$dir/keys.enc.json" "$HOST" "$KEY" 'umask 077 && cat >~/snapchain/casty/config/keys.enc.json && chmod 600 ~/snapchain/casty/config/keys.enc.json'
  else
    # A key store an earlier run shipped must not stay on a host that now reads only.
    on 'rm -f ~/snapchain/casty/config/keys.enc.json'
  fi
  (umask 077 && printf '%s' "$PASSPHRASE" >"$WORK/passphrase")
  remote_with_input "$WORK/passphrase" "$HOST" "$KEY" 'umask 077 && cat >~/snapchain/casty/passphrase && chmod 600 ~/snapchain/casty/passphrase'
  if [ -n "$DOMAIN" ]; then
    render "$TEMPLATES_DIR/Caddyfile.tmpl" DOMAIN="$DOMAIN" >"$WORK/Caddyfile"
    remote_with_input "$WORK/Caddyfile" "$HOST" "$KEY" 'cat >~/snapchain/casty/Caddyfile'
  fi
  render "$TEMPLATES_DIR/docker-compose.casty.yml.tmpl" PUBLIC_HOST="$public_host" READ_ONLY="$read_only" FRONT="$front" >"$WORK/casty.yml"
  remote_with_input "$WORK/casty.yml" "$HOST" "$KEY" 'cat >~/snapchain/docker-compose.casty.yml'
  # shellcheck disable=SC2016 # expanded by the remote shell
  on 'cd ~/snapchain && touch .env && { [ -z "$(tail -c 1 .env)" ] || echo >>.env; } &&
    { grep -q "^COMPOSE_FILE=" .env || echo "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.casty.yml" >>.env; }'

  # --remove-orphans: a caddy from an earlier --domain run goes when --tailscale replaces it.
  log "building the casty image on $HOST (a minute or two the first time)"
  if [ -n "$DOMAIN" ]; then
    on "cd ~/snapchain && docker compose build casty && docker compose up -d --remove-orphans casty caddy"
  else
    on "cd ~/snapchain && docker compose build casty && docker compose up -d --remove-orphans casty"
    # shellcheck disable=SC2016 # expanded by the remote shell
    on 'if [ "$(id -u)" = 0 ]; then tailscale serve --bg 3390; else sudo tailscale serve --bg 3390; fi'
  fi

  # The token is read through the running container: the file it writes belongs to root in
  # the bind mount, which a non-root login could not read, and a container that is not running
  # (a wrong passphrase, a failed build) answers nothing, whatever an earlier run left there.
  if [ "$DRY_RUN" = 1 ]; then
    token="<token>"
  else
    for attempt in $(seq "${SERVE_TRIES:-30}"); do
      token=$(on "cd ~/snapchain && docker compose exec -T casty cat /config/casty/web-token 2>/dev/null" || true)
      [ -z "$token" ] || break
      [ "$attempt" != 1 ] || log "waiting for casty to start"
      sleep "${SERVE_SLEEP:-2}"
    done
    [ -n "$token" ] || die 1 "casty did not start on $HOST (a wrong passphrase, or the build failed): $AGAIN logs casty shows why, as does cd ~/snapchain && docker compose logs casty on the host"
  fi
  log "casty serves at https://$public_host; the QR code is in its logs: $AGAIN logs casty"
  printf 'open to pair your phone: https://%s/#token=%s\n' "$public_host" "$token"
  if [ -n "$DOMAIN" ]; then
    log "for the certificate and the phone, $DOMAIN must point at $NODE_IP and 80 and 443 must be reachable from the internet: $(dirname "$0")/0-provision.sh --https opens them, keeping the server"
  fi
}

cmd_status() {
  if [ "$DRY_RUN" = 1 ]; then
    on curl -fsS --max-time 10 "${NODE_API:-http://127.0.0.1:3381}/v1/info"
    return 0
  fi
  local args=(--host "$HOST" --key "$KEY" --timeout "$TIMEOUT")
  [ "$WAIT" = 0 ] || args+=(--wait)
  "$LIB_DIR/node-status.sh" "${args[@]}"
}

cmd_up() {
  [ "$AUTOUPGRADE" = 0 ] || [ -n "$FID" ] ||
    die "$EXIT_USAGE" "--autoupgrade needs --fid: the upgrade weekday is derived from it"
  wait_for_ssh
  log "waiting for cloud-init to finish, if the host uses it"
  on 'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null || true; fi'
  # cloud-init adds the user to the docker group, and a login keeps the groups it started with:
  # the shared connection is closed so the next command logs in with that group.
  ssh_opts "$KEY"
  run ssh "${SSH_OPTS[@]}" "${SSH_SHARED[@]}" -O exit "$HOST" 2>/dev/null || true
  log "checking $HOST"
  preflight "$HOST" "$KEY" "$NODE_DATA_DIR" || die "$EXIT_PREFLIGHT" "$HOST does not meet the requirements above"
  log "writing ~/snapchain on $HOST"
  write_env
  fetch_release
  write_override
  [ "$AUTOUPGRADE" = 0 ] || install_autoupgrade
  log "starting snapchain and statsd"
  on "cd ~/snapchain && docker compose up -d snapchain statsd"
  log "the first start downloads a snapshot of several hundred GB, then catches up; expect hours"
  # Not "run up again": that would drop flags such as --release and restart the node.
  log "Ctrl-C ends only this wait: the node keeps syncing, $AGAIN status --wait picks up where it is, and $AGAIN tunnel opens the tunnel"
  WAIT=1 cmd_status
}

# The tunnel is an ssh master in the background, which ssh itself checks and stops through its
# control socket. -f returns once ssh has logged in and bound both local ports, so a taken port
# or a refused login fails here. ControlMaster=auto rather than -M: it replaces a socket that a
# crash or reboot left behind, where -M would run the tunnel without one that --stop can find.
# %C, a hash of the connection, keeps the path within macOS's 104 bytes for a socket.
cmd_tunnel() {
  local control
  ssh_opts "$KEY"
  control=(-S "$HOME/.ssh/casty-tunnel-%C" "${SSH_OPTS[@]}")
  if [ "$STOP" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      run ssh "${control[@]}" -O exit "$HOST"
    elif ssh "${control[@]}" -O exit "$HOST" 2>/dev/null; then
      log "tunnel stopped"
    else
      log "no tunnel is running"
    fi
    return 0
  fi
  if [ "$DRY_RUN" != 1 ] && ssh "${control[@]}" -O check "$HOST" 2>/dev/null; then
    log "the tunnel is already up"
    return 0
  fi
  local start=(ssh -f -N -o ControlMaster=auto "${control[@]}" -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 3381:127.0.0.1:3381 -L 3383:127.0.0.1:3383 "$HOST")
  if [ "$DRY_RUN" = 1 ]; then
    run "${start[@]}"
    return 0
  fi
  # The background ssh keeps the descriptors it starts with: none of them may be a pipe that
  # someone reads to the end, such as the output of $(...) or a test runner.
  if ! "${start[@]}" </dev/null >/dev/null 2>"$WORK/tunnel.err" 3>&-; then
    cat "$WORK/tunnel.err" >&2
    die 1 "the tunnel did not come up (ssh's reason is above)"
  fi
  log "tunnel up: http://127.0.0.1:3381 now reaches the node (stop it with ./scripts/1-node.sh tunnel --stop)"
}

case $COMMAND in
  "")
    cmd_up
    if [ "$TUNNEL" = 0 ]; then
      log "next: $AGAIN tunnel, then $(dirname "$0")/2-client.sh"
    else
      cmd_tunnel
      log "next: $(dirname "$0")/2-client.sh"
    fi
    ;;
  up) cmd_up ;;
  status) cmd_status ;;
  tunnel) cmd_tunnel ;;
  logs) on "cd ~/snapchain && docker compose logs -f --tail 100 $SERVICE" ;;
  serve) cmd_serve ;;
  upgrade)
    fetch_release
    on "cd ~/snapchain && docker compose pull && docker compose up -d snapchain statsd"
    ;;
  down) on "cd ~/snapchain && docker compose down" ;;
esac
