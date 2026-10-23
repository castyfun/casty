# shellcheck shell=bash disable=SC2034 # NODE_* are written to node.env by 0-provision.sh
# AWS EC2 through the aws CLI v2. Sourced by 0-provision.sh, which sets NAME, REGION, TYPE,
# DISK_GB, SSH_PUBKEY, ALLOW_IP, OUT_DIR and CLOUD_INIT. Resources are found again by their Name tag.

AWS_TYPES="m6i.xlarge m5.xlarge"
# Canonical publishes the current Ubuntu 24.04 AMI of every region under this SSM parameter.
AWS_UBUNTU_AMI=/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
AWS_ROOT_DISK='[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]'

provider_check() {
  require_cmd aws "Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  aws_credentials ||
    die "$EXIT_PREREQ" "no AWS credentials. Set AWS_PROFILE, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run aws configure (aws configure sso for SSO)."
}

aws_region() { echo "${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}}"; }

provider_plan() {
  echo "  server    $NAME: ${TYPE:-$AWS_TYPES} (the first one available), Ubuntu 24.04, $(aws_region)"
  echo "  firewall  security group $NAME-fw: ssh, 3381 and 3383 from $ALLOW_IP; gossip 3382 from$([ "$HTTPS" = 0 ] || echo ' anywhere; 80 and 443 from')"
  echo "            anywhere (on a group that exists, casty's own rules move here; others stay)"
}

# aws_value <dry-run placeholder> <aws args...>: one text value, empty for none.
aws_value() {
  local placeholder=$1 value
  shift
  if [ "$DRY_RUN" = 1 ]; then
    run aws "$@" --region "$NODE_REGION" --output text
    printf '%s\n' "$placeholder"
    return 0
  fi
  value=$(aws "$@" --region "$NODE_REGION" --output text) || return 1
  [ "$value" != None ] || value=""
  printf '%s\n' "$value"
}

aws_text() {
  aws_value "$@" || die "$EXIT_PROVIDER" "aws $2 $3 failed"
}

# The group's rules as EC2 IpPermissions, sent in one call: SSH and the node's APIs from
# --allow-ip only, gossip (3382) from anywhere so peers can connect.
# The descriptions of the rules aws_rules makes, as a JSON array: how a rerun tells them apart.
AWS_RULE_NAMES='["ssh", "snapchain http", "snapchain gossip", "snapchain grpc", "casty https"]'

aws_rules() {
  local extra=""
  [ "$HTTPS" = 0 ] || extra=',
  {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "casty https"}]},
  {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "casty https"}]}'
  cat <<JSON
[
  {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": "$ALLOW_IP", "Description": "ssh"}]},
  {"IpProtocol": "tcp", "FromPort": 3381, "ToPort": 3381, "IpRanges": [{"CidrIp": "$ALLOW_IP", "Description": "snapchain http"}]},
  {"IpProtocol": "udp", "FromPort": 3382, "ToPort": 3382, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "snapchain gossip"}]},
  {"IpProtocol": "tcp", "FromPort": 3382, "ToPort": 3382, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "snapchain gossip"}]},
  {"IpProtocol": "tcp", "FromPort": 3383, "ToPort": 3383, "IpRanges": [{"CidrIp": "$ALLOW_IP", "Description": "snapchain grpc"}]}$extra
]
JSON
}

provider_up() {
  local zone ami key group volume instance state type rules="$OUT_DIR/$NAME.firewall.json"
  NODE_REGION=$(aws_region)
  zone="${NODE_REGION}a"

  ami=$(aws_text ami-dryrun ssm get-parameter --name "$AWS_UBUNTU_AMI" --query Parameter.Value)
  # A key pair of that name is used only if it holds this public key (type and key; AWS may
  # append a comment). Its KeyFingerprint would need a different hash per key type.
  key=$(aws_text "" ec2 describe-key-pairs --filters "Name=key-name,Values=$NAME" --include-public-key \
    --query 'KeyPairs[].PublicKey')
  if [ -z "$key" ]; then
    aws_text "" ec2 import-key-pair --key-name "$NAME" --public-key-material "fileb://$SSH_PUBKEY" --query KeyName >/dev/null
  elif [ "$(printf '%s\n' "$key" | cut -d' ' -f1,2)" != "$(cut -d' ' -f1,2 "$SSH_PUBKEY")" ]; then
    die "$EXIT_PROVIDER" "$NODE_REGION has a different key pair named $NAME; pass another --name or --ssh-pubkey"
  fi

  group=$(aws_text "" ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-fw" --query 'SecurityGroups[].GroupId')
  if [ -z "$group" ]; then
    group=$(aws_text sg-dryrun ec2 create-security-group --group-name "$NAME-fw" \
      --description "casty snapchain read node" --query GroupId)
  else
    # A rerun from another network moves SSH and the node's APIs to the current --allow-ip: the
    # rules casty made, told apart by their descriptions, are revoked and made afresh below.
    # Rules someone added by hand stay; casty can always make its own again.
    local old
    old=$(mktemp)
    run aws ec2 describe-security-groups --group-ids "$group" --region "$NODE_REGION" --output json \
      --query "SecurityGroups[0].IpPermissions[].{IpProtocol: IpProtocol, FromPort: FromPort, ToPort: ToPort, IpRanges: IpRanges[?contains(\`$AWS_RULE_NAMES\`, Description)]} | [?length(IpRanges) > \`0\`]" \
      >"$old" || die "$EXIT_PROVIDER" "aws ec2 describe-security-groups failed"
    if [ "$DRY_RUN" = 1 ] || [ "$(tr -d '[:space:]' <"$old")" != "[]" ]; then
      aws_text "" ec2 revoke-security-group-ingress --group-id "$group" --ip-permissions "file://$old" \
        --query Return >/dev/null
    fi
    rm -f "$old"
  fi
  aws_rules >"$rules"
  aws_text "" ec2 authorize-security-group-ingress --group-id "$group" --ip-permissions "file://$rules" \
    --query Return >/dev/null

  volume=$(aws_text "" ec2 describe-volumes --filters "Name=tag:Name,Values=$NAME-data" --query 'Volumes[].VolumeId')
  [ -n "$volume" ] || volume=$(aws_text vol-dryrun ec2 create-volume --availability-zone "$zone" --size "$DISK_GB" \
    --volume-type gp3 --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=$NAME-data}]" --query VolumeId)
  NODE_VOLUME_ID=$volume

  instance=$(aws_text "" ec2 describe-instances --query 'Reservations[].Instances[].InstanceId' \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped")
  if [ -z "$instance" ]; then
    # Nitro instances expose EBS volumes as NVMe devices named after the volume id.
    render "$TEMPLATES_DIR/cloud-init.yaml.tmpl" NAME="$NAME" USER=ubuntu HOME=/home/ubuntu \
      DATA_DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volume//-/}" >"$CLOUD_INIT"
    for type in ${TYPE:-$AWS_TYPES}; do
      instance=$(aws_value i-dryrun ec2 run-instances --image-id "$ami" --instance-type "$type" \
        --key-name "$NAME" --security-group-ids "$group" --placement "AvailabilityZone=$zone" \
        --user-data "file://$CLOUD_INIT" --block-device-mappings "$AWS_ROOT_DISK" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
        --query 'Instances[0].InstanceId') && [ -n "$instance" ] && started_now && break
      warn "could not start a $type instance in $zone; trying the next type"
      instance=""
    done
    [ -n "$instance" ] || die "$EXIT_PROVIDER" "none of ${TYPE:-$AWS_TYPES} could be started in $zone"
  else
    # Found stopped (in the console, or by AWS): started again once it has finished stopping.
    state=$(aws_text running ec2 describe-instances --instance-ids "$instance" \
      --query 'Reservations[0].Instances[0].State.Name')
    if [ "$state" = stopping ] || [ "$state" = stopped ]; then
      run aws ec2 wait instance-stopped --instance-ids "$instance" --region "$NODE_REGION" ||
        die "$EXIT_PROVIDER" "instance $instance did not stop"
      aws_text "" ec2 start-instances --instance-ids "$instance" \
        --query 'StartingInstances[0].CurrentState.Name' >/dev/null
      started_now
    fi
  fi
  NODE_SERVER_ID=$instance

  run aws ec2 wait instance-running --instance-ids "$instance" --region "$NODE_REGION" ||
    die "$EXIT_PROVIDER" "instance $instance did not start"
  state=$(aws_text available ec2 describe-volumes --volume-ids "$volume" --query 'Volumes[0].State')
  if [ "$state" = available ]; then
    aws_text "" ec2 attach-volume --volume-id "$volume" --instance-id "$instance" --device /dev/sdf --query State >/dev/null
  fi
  NODE_IP=$(aws_text 192.0.2.1 ec2 describe-instances --instance-ids "$instance" \
    --query 'Reservations[0].Instances[0].PublicIpAddress')
  [ -n "$NODE_IP" ] ||
    die "$EXIT_PROVIDER" "instance $instance has no public IP address: its subnet may not assign one; give it an Elastic IP, then run this again"
  NODE_USER=ubuntu
}

# ids <ids...>: each id once, one per line; the aws text output separates ids with tabs.
ids() {
  # shellcheck disable=SC2048,SC2086 # split on purpose
  printf '%s\n' $* | sort -u
}

# The ids node.env records; for one it does not record, the ones the Name tag finds, as
# provider_up looks for them: a run stopped between creating a volume or an instance and writing
# node.env leaves only the tag. A recorded id is never widened to the tag, which other people's
# resources in a shared account may carry too.
provider_destroy() {
  local found="" group instances volume
  [ -n "$NODE_SERVER_ID" ] ||
    found=$(aws_text "" ec2 describe-instances --query 'Reservations[].Instances[].InstanceId' \
      --filters "Name=tag:Name,Values=$NODE_NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped")
  instances=$(ids "$NODE_SERVER_ID" "$found")
  if [ -n "$instances" ]; then
    # shellcheck disable=SC2086 # one argument per id
    aws_text "" ec2 terminate-instances --instance-ids $instances --query 'TerminatingInstances[].CurrentState.Name' >/dev/null
    # shellcheck disable=SC2086
    run aws ec2 wait instance-terminated --instance-ids $instances --region "$NODE_REGION" ||
      die "$EXIT_PROVIDER" "instance $instances did not terminate"
  fi
  found=""
  [ -n "$NODE_VOLUME_ID" ] ||
    found=$(aws_text "" ec2 describe-volumes --filters "Name=tag:Name,Values=$NODE_NAME-data" --query 'Volumes[].VolumeId')
  for volume in $(ids "$NODE_VOLUME_ID" "$found"); do
    aws_text "" ec2 delete-volume --volume-id "$volume" --query Return >/dev/null
  done
  group=$(aws_text "" ec2 describe-security-groups --filters "Name=group-name,Values=$NODE_NAME-fw" --query 'SecurityGroups[].GroupId')
  [ -z "$group" ] || aws_text "" ec2 delete-security-group --group-id "$group" --query Return >/dev/null
}
