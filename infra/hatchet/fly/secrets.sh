#!/usr/bin/env bash
# Print the fly secrets set commands for a producer application's engine app. This script never
# calls `fly` and never generates a value — it only prints commands with
# placeholders for the producer's operator to fill in and run by hand.
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
    The direct connection string from the cluster's page in the Fly
    dashboard, not the pooler (Hatchet needs a session-mode connection for
    LISTEN/NOTIFY, prepared statements and advisory locks; a transaction
    pooler breaks all three). It needs no sslmode parameter.
  ADMIN_EMAIL
    Chosen by the operator for the dashboard admin account: a lower-case
    address on the company domain.
  ADMIN_PASSWORD
    Chosen by the operator for the dashboard admin account.
  SERVER_MSGQUEUE_RABBITMQ_URL
    Needed while fly.toml sets SERVER_MSGQUEUE_KIND = 'rabbitmq'. Built from
    the two values set on <rabbitmq-app> (infra/hatchet/fly/rabbitmq/secrets.sh):
    amqp://<user>:<pass>@<rabbitmq-app>.internal:5672/
  SERVER_URL
    The engine's public URL: https://<engine-app>.fly.dev (the app's public hostname).
  SERVER_AUTH_COOKIE_DOMAIN
    The app's public hostname: <engine-app>.fly.dev
  SERVER_GRPC_BROADCAST_ADDRESS
    The public hostname and gRPC port: <engine-app>.fly.dev:7077
  SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS
    The company email domain. The engine checks it at login as well as
    signup, so the admin account must be on it.

  Optional (see the block below): SERVER_AUTH_COOKIE_SECRETS,
  SERVER_ENCRYPTION_MASTER_KEYSET, SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET,
  SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET.

Commands to run:

fly secrets set --stage -a '${APP}' DATABASE_URL='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' ADMIN_EMAIL='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' ADMIN_PASSWORD='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_MSGQUEUE_RABBITMQ_URL='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_URL='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_AUTH_COOKIE_DOMAIN='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_GRPC_BROADCAST_ADDRESS='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS='<REPLACE_ME>'

Optional overrides (not needed for a normal deploy):
  The engine generates these into /config on first boot and the
  config volume that fly.toml mounts keeps them; set them only to hold the keys
  outside the volume, and note that once set, the environment value wins
  over whatever /config holds.

fly secrets set --stage -a '${APP}' SERVER_AUTH_COOKIE_SECRETS='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_ENCRYPTION_MASTER_KEYSET='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET='<REPLACE_ME>'
fly secrets set --stage -a '${APP}' SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET='<REPLACE_ME>'

Then apply everything staged in one deploy:

fly deploy -c infra/hatchet/fly/fly.toml -a '${APP}'

Store every value in 1Password. Never paste one into a pull request or a
chat message.
EOF
