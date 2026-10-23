#!/usr/bin/env bats
load helpers

# in_common <code>: runs bash code with lib/common.sh sourced, under the scripts' own set flags.
in_common() { bash -c "set -euo pipefail; . '$ROOT/scripts/lib/common.sh'; $1"; }

@test "random_token prints the length asked for and succeeds under pipefail" {
  run in_common 'random_token 16'
  assert_success
  [[ "$output" =~ ^[A-Za-z0-9]{16}$ ]]
}
