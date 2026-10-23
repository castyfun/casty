#!/usr/bin/env bats
load helpers

render() {
  setup_fakes
  "$ROOT/scripts/0-provision.sh" --provider "$1" --dry-run --out "$BATS_TEST_TMPDIR/node.env" --ssh-pubkey "$PUBKEY" >/dev/null
  CLOUD_INIT="$BATS_TEST_TMPDIR/fc-node.cloud-init.yaml"
}

@test "is valid YAML with the #cloud-config header" {
  render hetzner
  head -1 "$CLOUD_INIT" | grep -qx "#cloud-config"
  yq '.' "$CLOUD_INIT" >/dev/null
}

@test "leaves no template placeholder behind" {
  render aws
  run grep -F "{{" "$CLOUD_INIT"
  assert_failure
}

@test "mounts the data volume at /data by id, ext4 with noatime" {
  render hetzner
  grep -q 'device="/dev/disk/by-id/scsi-0HC_Volume_dry-run-volume"' "$CLOUD_INIT"
  grep -q '/data ext4 defaults,noatime,nofail' "$CLOUD_INIT"
}

@test "formats only a volume blkid reports as blank, and stops on any other blkid failure" {
  render hetzner
  grep -q 'blkid -p "$device" >/dev/null || status=$?' "$CLOUD_INIT"
  grep -q 'if \[ "$status" = 2 \]; then mkfs.ext4 -m 0' "$CLOUD_INIT"
  grep -q 'not formatting' "$CLOUD_INIT"
}

@test "reserves no blocks for root on the data volume" {
  render hetzner
  grep -q 'tune2fs -m 0 "$device"' "$CLOUD_INIT"
}

@test "finds the AWS data volume by its NVMe id" {
  render aws
  grep -q 'device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_voldryrun"' "$CLOUD_INIT"
}

@test "links the user's ~/snapchain to /data/snapchain" {
  render aws
  grep -q "ln -s /data/snapchain /home/ubuntu/snapchain" "$CLOUD_INIT"
}

@test "installs Docker with the official convenience script, plus chrony and jq" {
  render hetzner
  grep -q "https://get.docker.com" "$CLOUD_INIT"
  [ "$(yq '.packages | join(",")' "$CLOUD_INIT")" = "chrony,jq" ]
}

# docker_install <failures>: runs the Docker install script from cloud-init with a curl that
# fails <failures> times, then serves a stand-in for get.docker.com, and with no real sleep.
docker_install() {
  render hetzner
  local bin="$BATS_TEST_TMPDIR/boot-bin"
  mkdir -p "$bin"
  yq '.write_files[] | select(.path == "/usr/local/sbin/casty-docker") | .content' "$CLOUD_INIT" >"$BATS_TEST_TMPDIR/casty-docker"
  printf '#!/bin/sh\necho "curl $*" >>"%s"\n[ "$(grep -c . "%s")" -gt %s ] || exit 22\necho "echo docker installed"\n' \
    "$BATS_TEST_TMPDIR/curl.log" "$BATS_TEST_TMPDIR/curl.log" "$1" >"$bin/curl"
  printf '#!/bin/sh\n' >"$bin/sleep"
  chmod +x "$bin/curl" "$bin/sleep"
  PATH="$bin:$PATH" run bash "$BATS_TEST_TMPDIR/casty-docker"
}

# data_volume [blkid status] [mounted]: runs cloud-init's data-volume script with its paths moved
# under $HOST_ROOT, a file for the volume, a blkid that exits with <blkid status> (default 0, a
# volume with a filesystem), a mountpoint that says <mounted> (default no), and stand-ins for
# mkfs.ext4, tune2fs, mount and chown that write their calls to $BOOT_LOG.
data_volume() {
  render hetzner
  HOST_ROOT="$BATS_TEST_TMPDIR/host"
  BOOT_LOG="$BATS_TEST_TMPDIR/boot.log"
  local bin="$BATS_TEST_TMPDIR/volume-bin" tool
  mkdir -p "$bin" "$HOST_ROOT/etc" "$HOST_ROOT/root" "$HOST_ROOT/dev"
  touch "$HOST_ROOT/etc/fstab" "$HOST_ROOT/dev/volume" "$BOOT_LOG"
  yq '.write_files[] | select(.path == "/usr/local/sbin/casty-data-volume") | .content' "$CLOUD_INIT" |
    sed -e "s#/dev/disk/by-id/[^\"]*#$HOST_ROOT/dev/volume#" -e "s#/root/#$HOST_ROOT/root/#g" \
      -e "s#/etc/fstab#$HOST_ROOT/etc/fstab#g" -e "s#/data#$HOST_ROOT/data#g" >"$BATS_TEST_TMPDIR/casty-data-volume"
  for tool in mkfs.ext4 tune2fs mount chown; do
    printf '#!/bin/sh\necho "%s $*" >>"%s"\n' "$tool" "$BOOT_LOG" >"$bin/$tool"
  done
  printf '#!/bin/sh\nexit %s\n' "${1:-0}" >"$bin/blkid"
  printf '#!/bin/sh\n[ "%s" = yes ]\n' "${2:-no}" >"$bin/mountpoint"
  printf '#!/bin/sh\n' >"$bin/sleep"
  chmod +x "$bin"/*
  PATH="$bin:$PATH" run bash "$BATS_TEST_TMPDIR/casty-data-volume"
}

@test "formats a blank data volume, mounts it at /data and links ~/snapchain to it" {
  data_volume 2
  assert_success
  grep -qx "mkfs.ext4 -m 0 -L snapchain $HOST_ROOT/dev/volume" "$BOOT_LOG"
  grep -qx "$HOST_ROOT/dev/volume $HOST_ROOT/data ext4 defaults,noatime,nofail 0 2" "$HOST_ROOT/etc/fstab"
  grep -qx "mount $HOST_ROOT/data" "$BOOT_LOG"
  [ "$(readlink "$HOST_ROOT/root/snapchain")" = "$HOST_ROOT/data/snapchain" ]
}

@test "mounts a data volume that already has a filesystem without formatting it" {
  data_volume 0
  assert_success
  run grep mkfs "$BOOT_LOG"
  assert_failure
  grep -qx "mount $HOST_ROOT/data" "$BOOT_LOG"
}

@test "stops without formatting when blkid fails for another reason than a blank volume" {
  data_volume 4
  assert_failure
  assert_output --partial "not formatting"
  run grep -e mkfs -e mount "$BOOT_LOG"
  assert_failure
  [ ! -s "$HOST_ROOT/etc/fstab" ]
}

@test "run again, adds no second fstab line and mounts nothing already mounted" {
  data_volume 0
  data_volume 0 yes
  assert_success
  [ "$(grep -c " $HOST_ROOT/data " "$HOST_ROOT/etc/fstab")" = 1 ]
  [ "$(grep -c "^mount " "$BOOT_LOG")" = 1 ]
  # ln -s onto the link to a directory would put a second link inside /data/snapchain.
  [ ! -e "$HOST_ROOT/data/snapchain/snapchain" ]
}

@test "stops when the data volume never appears" {
  data_volume
  rm "$HOST_ROOT/dev/volume"
  PATH="$BATS_TEST_TMPDIR/volume-bin:$PATH" run bash "$BATS_TEST_TMPDIR/casty-data-volume"
  assert_failure
  assert_output --partial "never appeared"
}

@test "runs the Docker install from a script that cloud-init runs" {
  render hetzner
  [ "$(yq '[.runcmd[] | select(tag == "!!seq" and .[0] == "/usr/local/sbin/casty-docker")] | length' "$CLOUD_INIT")" = 1 ]
}

@test "retries a Docker install that fails, as a new server's network can at first" {
  docker_install 2
  assert_success
  assert_output --partial "docker installed"
  [ "$(grep -c 'https://get.docker.com' "$BATS_TEST_TMPDIR/curl.log")" = 3 ]
}

@test "gives up on the Docker install after five tries" {
  docker_install 99
  assert_failure
  [ "$(grep -c . "$BATS_TEST_TMPDIR/curl.log")" = 5 ]
}

@test "raises fs.file-max and the nofile limit" {
  render hetzner
  grep -q "fs.file-max" "$CLOUD_INIT"
  grep -q "nofile" "$CLOUD_INIT"
}

@test "never reboots" {
  render hetzner
  run grep -i -E "reboot|power_state" "$CLOUD_INIT"
  assert_failure
}
