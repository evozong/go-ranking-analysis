#!/usr/bin/env bash
# Export credentials from the (login-session) awscli profile the tofu AWS
# provider cannot read on its own, then run tofu from this directory.
#
#   ./deploy.sh apply            # or: plan, destroy, apply -auto-approve, ...
#
# Override the profile with AWS_PROFILE_DEPLOY (defaults to `admin`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="${AWS_PROFILE_DEPLOY:-admin}"

eval "$(aws configure export-credentials --profile "$profile" --format env)"

exec tofu -chdir="$here" "${@:-apply}"
