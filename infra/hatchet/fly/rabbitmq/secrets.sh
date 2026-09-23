#!/usr/bin/env bash
# Print the fly secrets set commands for <rabbitmq-app>. This script never
# calls `fly` and never generates a value — it only prints commands with
# placeholders for the CTO to fill in and run by hand.
#
#   bash infra/hatchet/fly/rabbitmq/secrets.sh
#
# Store every real value in 1Password. Never paste one into a pull request,
# an issue, a commit, or a chat message.
set -euo pipefail

APP='<rabbitmq-app>'

cat <<EOF
This script only prints commands. It does not call fly and does not
generate any value. Run the printed commands yourself, then deploy.

App: ${APP}

Secrets this app needs, and where each value comes from:
  RABBITMQ_DEFAULT_USER
    Chosen by the CTO.
  RABBITMQ_DEFAULT_PASS
    Generated in 1Password. Letters and digits only, so the engine's
    amqp://<user>:<pass>@<rabbitmq-app>.internal:5672/ URL needs no
    escaping.

RabbitMQ reads both only on its first boot with an empty data volume.
Without them it creates a guest account that this image lets connect from
other machines. Stage both before the first deploy; changing them later
changes nothing.

Commands to run:

fly secrets set --stage -a ${APP} RABBITMQ_DEFAULT_USER='<REPLACE_ME>'
fly secrets set --stage -a ${APP} RABBITMQ_DEFAULT_PASS='<REPLACE_ME>'

Then set the engine's SERVER_MSGQUEUE_RABBITMQ_URL from the same two
values: bash infra/hatchet/fly/secrets.sh

Then deploy (the kyu_rabbitmq_data volume must already exist):

fly deploy -c infra/hatchet/fly/rabbitmq/fly.toml -a ${APP} --ha=false

Store every value in 1Password. Never paste one into a pull request or a
chat message.
EOF
