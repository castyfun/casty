#!/usr/bin/env bash
# Runs on the node host (piped over ssh): can it run a Snapchain read node?
# Usage: bash -s -- <data dir> <caller's unix time> [<min free GiB>] < preflight.sh
# Prints one table row per check and exits 5 when RAM, disk, Docker or the clock fall short.
# PREFLIGHT_MEM_KB and PREFLIGHT_FREE_KB replace the measurements, for tests only.
set -uo pipefail

data_dir=${1:-/data}
data_dir=${data_dir/#\~/$HOME}
caller_time=${2:-}
need_mem_kb=$((15 * 1024 * 1024))      # 15 GiB: the docs ask for 16 GB, and the kernel keeps some
need_free_kb=$((18 * 1024 * 1024 * 1024 / 10)) # 1.8 TiB of the 2 TB the docs ask for
need_free="1.8 TiB"
if [ -n "${3:-}" ]; then # CASTY_MIN_FREE_GIB: a smaller disk, at the owner's risk
  need_free_kb=$(($3 * 1024 * 1024))
  need_free="$3 GiB"
fi
failed=0

row() { printf '%-8s %-12s %-12s %s\n' "$1" "$2" "$3" "$4"; }
check() { # check <name> <value> <need> <ok?>
  if [ "$4" = yes ]; then row "$1" "$2" "$3" yes; else row "$1" "$2" "$3" no; failed=1; fi
}
gib() { awk -v kb="$1" 'BEGIN { printf "%.1f GiB", kb / 1048576 }'; }
tib() { awk -v kb="$1" 'BEGIN { printf "%.2f TiB", kb / 1073741824 }'; }
# at_least <version> <minimum>: prints yes when the first x.y.z is at least the second. A
# suffix such as -desktop.1 is ignored, an empty version is 0.
at_least() {
  awk -v have="$1" -v need="$2" 'function n(v, p) { split(v, p, "."); return p[1] * 1e6 + p[2] * 1e3 + p[3] }
    BEGIN { if (n(have) >= n(need)) print "yes" }'
}

row CHECK VALUE NEED OK

mem_kb=${PREFLIGHT_MEM_KB:-$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)}
mem_kb=${mem_kb:-0}
check ram "$(gib "$mem_kb")" "15 GiB" "$([ "$mem_kb" -ge "$need_mem_kb" ] && echo yes)"

if [ -d "$HOME/snapchain/.rocks" ]; then
  row disk "in use" "$need_free" "yes (existing database, not re-measured)"
else
  free_kb=${PREFLIGHT_FREE_KB:-$(df -Pk "$data_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')}
  free_kb=${free_kb:-0}
  check disk "$(tib "$free_kb")" "$need_free" "$([ "$free_kb" -ge "$need_free_kb" ] && echo yes)"
fi

docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
docker_state=missing
command -v docker >/dev/null 2>&1 && docker_state="no server" # stopped, or no access to it
check docker "${docker_version:-$docker_state}" "installed" "$([ -n "$docker_version" ] && echo yes)"

# The override replaces Grafana's ports with `ports: !override`, which older Compose rejects.
compose_version=$(docker compose version --short 2>/dev/null || true)
compose_version=${compose_version#v}
check compose "${compose_version:-missing}" "2.24.4 or newer" "$(at_least "$compose_version" 2.24.4)"

if command -v ss >/dev/null 2>&1; then
  busy=$(ss -Hltnu 2>/dev/null | awk '{ print $5 }' | grep -Eo ':(3381|3382|3383)$' | tr -d : | sort -u | tr '\n' ' ')
  # Informational: on a second run the node itself holds these ports.
  row ports "${busy:-free}" "3381-3383" "yes${busy:+ (in use; fine if it is this node)}"
fi

if [ -n "$caller_time" ]; then
  skew=$(($(date +%s) - caller_time))
  skew=${skew#-}
  check clock "${skew} s" "<= 60 s" "$([ "$skew" -le 60 ] && echo yes)"
fi

exit $((failed * 5))
