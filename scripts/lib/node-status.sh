#!/usr/bin/env bash
# Snapchain sync status from GET /v1/info: one line per shard; with --wait, then one line per
# check with how far behind the node is and an ETA, and the full status again once synced.
# Exits 0 once every shard's blockDelay is under 10 seconds, 1 otherwise.
#
# node-status.sh [--file <info.json>] [--host <user@ip> --key <private key>] [--wait] [--timeout <s>]
#
# With --host the node is asked over ssh (curl on the host), so port 3381 never has to be public.
# NODE_API overrides the node URL as seen from where curl runs; POLL_MIN and POLL_MAX (seconds)
# set the --wait backoff, which grows from 10 s to 60 s.
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

NODE_API=${NODE_API:-http://127.0.0.1:3381}
POLL_MIN=${POLL_MIN:-10}
POLL_MAX=${POLL_MAX:-60}
file="" host="" key="" wait=0 timeout=43200

while [ $# -gt 0 ]; do
  case $1 in
    --file) file=$2 && shift ;;
    --host) host=$2 && shift ;;
    --key) key=$2 && shift ;;
    --wait) wait=1 ;;
    --timeout) timeout=$2 && shift ;;
    *) die "$EXIT_USAGE" "unknown argument $1" ;;
  esac
  shift
done
require_cmd jq "Install it with your package manager (apt install jq, brew install jq)."

fetch() {
  if [ -n "$file" ]; then
    cat "$file"
  elif [ -n "$host" ]; then
    remote "$host" "$key" curl -fsS --max-time 10 "$NODE_API/v1/info"
  else
    curl -fsS --max-time 10 "$NODE_API/v1/info"
  fi
}

# One line per shard, in shard order, plus one line per shard the node did not report.
shards() {
  jq -r '
    def gib: if . == null then "n/a" else "\((. / 107374182.4 | floor) / 10) GiB" end;
    def mempool: if . == null or . == 4294967295 then "n/a" else tostring end;
    ((.shardInfos // []) | sort_by(.shardId)[]
      | "shard \(.shardId)  height \(.maxHeight // "n/a")  behind \(.blockDelay // "n/a")s  size \(.approxSize | gib)  mempool \(.mempoolSize | mempool)"),
    (([range(0; (.numShards // 0) + 1)] - [(.shardInfos // [])[].shardId])[]
      | "shard \(.)  missing from /v1/info")'
}

synced() {
  jq -e '((.numShards // 0) + 1) as $n | (.shardInfos // []) as $s
    | ($s | length) > 0 and ($s | length) >= $n and all($s[]; (.blockDelay // 1e9) < 10)' >/dev/null
}

lag() { jq '[(.shardInfos // [])[].blockDelay // 0] | max // 0'; }

duration() {
  local s=$1
  if [ "$s" -ge 3600 ]; then echo "$((s / 3600))h $((s % 3600 / 60))m"; elif [ "$s" -ge 60 ]; then echo "$((s / 60))m"; else echo "${s}s"; fi
}

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
started=$(date +%s)
interval=$POLL_MIN
first_time="" first_lag="" warned=0 ssh_failures=0
while :; do
  status=0
  info=$(fetch 2>"$errors") || status=$?
  # 255 is ssh's own failure (curl's codes stay below 100). It may pass on a flaky network,
  # but three in a row mean no connection, which waiting 12 hours would only hide.
  if [ "$status" = 255 ]; then ssh_failures=$((ssh_failures + 1)); else ssh_failures=0; fi
  if [ "$status" = 0 ] && [ -n "$info" ] && printf '%s' "$info" | jq -e . >/dev/null 2>&1; then
    state=no
    printf '%s' "$info" | synced && state=yes
    now=$(date +%s)
    current_lag=$(printf '%s' "$info" | lag)
    current_lag=${current_lag%.*}
    if [ -z "$first_time" ] || [ "$state" = yes ]; then
      echo "snapchain $(printf '%s' "$info" | jq -r '.version // "unknown"'), synced: $state"
      printf '%s' "$info" | shards
    else
      # While waiting, one line per check under the full status printed first. The ETA uses
      # the rate since that first check, which jumps around less than the last interval's.
      elapsed=$((now - first_time > 0 ? now - first_time : 1))
      gained=$((first_lag - current_lag))
      eta=unknown
      [ "$gained" -le 0 ] || eta=$(duration $((current_lag * elapsed / gained)))
      echo "$(date +%H:%M)  $(duration "$current_lag") behind, ETA $eta"
    fi
    [ "$state" = yes ] && exit 0
    [ -n "$first_time" ] || { first_time=$now && first_lag=$current_lag; }
  elif [ -n "$file" ]; then
    die 1 "$file did not return JSON"
  elif [ "$ssh_failures" -ge 3 ] || { [ "$ssh_failures" -ge 1 ] && [ "$wait" = 0 ]; }; then
    die 1 "no ssh connection to $host: $(tail -n 1 "$errors")"
  elif [ "$warned" = 0 ]; then
    warn "the node did not return JSON from $NODE_API/v1/info (still starting?); waiting for it"
    warned=1
  fi
  [ "$wait" = 1 ] || exit 1
  [ $(($(date +%s) - started)) -lt "$timeout" ] || die 1 "not synced after ${timeout}s"
  sleep "$interval"
  interval=$((interval * 2 < POLL_MAX ? interval * 2 : POLL_MAX))
  [ "$interval" -ge "$POLL_MIN" ] || interval=$POLL_MIN
done
