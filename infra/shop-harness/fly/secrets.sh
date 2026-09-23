#!/usr/bin/env bash
# Print the fly secrets commands for <shop-harness-app> (#166). This
# script never calls fly and never generates a value — it only prints
# commands with placeholders for the CTO to fill in and run by hand.
#
#   bash infra/shop-harness/fly/secrets.sh
#
# Store every real value in 1Password. Never paste one into a pull request,
# an issue, a commit, or a chat message.
set -euo pipefail

APP='<shop-harness-app>'
ENGINE_APP='<engine-app>'

cat <<EOF
This script only prints commands. It does not call fly and does not
generate any value. Run the printed commands yourself.

App: ${APP}

Secrets this app needs, and where each value comes from:
  KYU_SHOP_DATABASE_URL
    The direct connection string of the <shop-harness-db> cluster,
    from its page in the Fly dashboard (not the pooler — the relay and
    migrations need session-mode semantics), with the database name in the
    path changed to kyu_shop_inregion.
    Use the <shop-harness-db> cluster (id <shop-cluster-id>), NOT the
    engine's <engine-db> (<engine-cluster-id>); a string from the
    engine's cluster fails migrate with 'permission denied to create
    database'.
  HATCHET_CLIENT_TOKEN
    A worker token for ${ENGINE_APP}, minted by infra/hatchet/fly/token.sh
    and piped straight into fly secrets import so it never appears on
    screen or in shell history as a command argument.

Commands to run:

fly secrets set --stage -a ${APP} KYU_SHOP_DATABASE_URL='<REPLACE_ME>'

printf 'HATCHET_CLIENT_TOKEN=%s\n' "\$(bash infra/hatchet/fly/token.sh -a ${ENGINE_APP})" | fly secrets import --stage -a ${APP}

Apply the staged secrets with this deploy:

fly deploy -c infra/shop-harness/fly/fly.toml --dockerfile infra/shop-harness/fly/Dockerfile --ignorefile infra/shop-harness/fly/harness.dockerignore --build-arg KYU_HARNESS_COMMIT_SHA="\$(git rev-parse HEAD)" --ha=false -a ${APP}

Store every value in 1Password. Never paste one into a pull request or a
chat message.
EOF
