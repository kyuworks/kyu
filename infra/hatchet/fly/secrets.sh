#!/usr/bin/env bash
# Print the fly secrets set commands for <engine-app>. This script never
# calls `fly` and never generates a value — it only prints commands with
# placeholders for the CTO to fill in and run by hand.
#
#   bash infra/hatchet/fly/secrets.sh
#
# Store every real value in 1Password. Never paste one into a pull request,
# an issue, a commit, or a chat message.
set -euo pipefail

APP='<engine-app>'

cat <<EOF
This script only prints commands. It does not call fly and does not
generate any value. Run the printed commands yourself, then deploy.

App: ${APP}

Secrets this app needs, and where each value comes from:
  DATABASE_URL
    The managed Postgres session-mode connection string, from
    'fly mpg attach <cluster id> -a ${APP}' or read from the cluster's
    connection details in the Fly dashboard.
  SERVER_AUTH_COOKIE_SECRETS
    Generated per the Hatchet self-hosting docs (a random cookie hashing
    and encryption key pair).
  SERVER_ENCRYPTION_MASTER_KEYSET
    Generated per the Hatchet self-hosting docs (the engine's master
    encryption keyset).
  SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET
    Generated per the Hatchet self-hosting docs (the engine's JWT signing
    private keyset).
  SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET
    Generated per the Hatchet self-hosting docs (the engine's JWT signing
    public keyset, paired with the private keyset above).
  SERVER_AUTH_ADMIN_EMAIL
    Chosen by the CTO for the dashboard admin account.
  SERVER_AUTH_ADMIN_PASSWORD
    Chosen by the CTO for the dashboard admin account.

Commands to run:

fly secrets set --stage -a ${APP} DATABASE_URL='<REPLACE_ME>'
fly secrets set --stage -a ${APP} SERVER_AUTH_COOKIE_SECRETS='<REPLACE_ME>'
fly secrets set --stage -a ${APP} SERVER_ENCRYPTION_MASTER_KEYSET='<REPLACE_ME>'
fly secrets set --stage -a ${APP} SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET='<REPLACE_ME>'
fly secrets set --stage -a ${APP} SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET='<REPLACE_ME>'
fly secrets set --stage -a ${APP} SERVER_AUTH_ADMIN_EMAIL='<REPLACE_ME>'
fly secrets set --stage -a ${APP} SERVER_AUTH_ADMIN_PASSWORD='<REPLACE_ME>'

Then apply everything staged in one deploy:

fly deploy -c infra/hatchet/fly/fly.toml -a ${APP}

Store every value in 1Password. Never paste one into a pull request or a
chat message.
EOF
