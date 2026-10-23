# shellcheck shell=bash disable=SC2034 # NODE_* are written to node.env by 0-provision.sh
# Cherry Servers through cherryctl. Only --dry-run works so far: it shows the calls a live run
# would make. The cherryctl flags, plan slug and volume device name are not yet checked against
# a live account; provider_check refuses a live run until they are.

CHERRY_PLAN=TODO-plan-with-16GB-RAM
CHERRY_IMAGE=ubuntu_24_04
CHERRY_REGION=eu_nord_1

provider_check() {
  die "$EXIT_PROVIDER" "Cherry Servers is dry-run only for now. Create the server by hand, then use --provider existing --host root@<ip>."
  require_cmd cherryctl "Install it: https://github.com/cherryservers/cherryctl"
  require_env CHERRY_AUTH_TOKEN "Create an API key in the Cherry Servers portal."
  require_env CHERRY_PROJECT_ID "Find it in the Cherry Servers portal, under your project."
}

provider_up() {
  local project=${CHERRY_PROJECT_ID:-dry-run-project} region=${REGION:-$CHERRY_REGION}
  NODE_REGION=$region
  render "$TEMPLATES_DIR/cloud-init.yaml.tmpl" NAME="$NAME" USER=root HOME=/root \
    DATA_DEVICE="/dev/disk/by-id/TODO-cherry-volume" >"$CLOUD_INIT"
  run cherryctl ssh-key create --label "$NAME" --key-file "$SSH_PUBKEY"
  run cherryctl storage create --project-id "$project" --size "$DISK_GB" --region "$region" --description "$NAME-data"
  run cherryctl server create --project-id "$project" --plan "${TYPE:-$CHERRY_PLAN}" --image "$CHERRY_IMAGE" \
    --region "$region" --hostname "$NAME" --ssh-keys "$NAME" --userdata-file "$CLOUD_INIT"
  run cherryctl storage attach --server-id dry-run --storage-id dry-run-volume
  NODE_SERVER_ID=dry-run
  NODE_VOLUME_ID=dry-run-volume
  NODE_IP=192.0.2.1
  NODE_USER=root
}

provider_destroy() {
  die "$EXIT_PROVIDER" "Cherry Servers is dry-run only for now; delete the server in the portal."
}
