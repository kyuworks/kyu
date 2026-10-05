# Run an engine for your application on Fly

This page is for the operator of a producer application: the application that publishes to the bus. It takes you from nothing to a Hatchet engine for one environment, then covers bus tenants, tokens, upgrades, backups, alerts and faults. Run it once for each environment (dev, staging, production).

Kyu runs no engine of its own. Each producer application runs its own engine from the template in [`infra/hatchet/fly/`](../../infra/hatchet/fly/)
([ADR](../architecture/adr/20261006-each-producer-application-runs-its-own-engine.md)). The local stack (`infra/hatchet/compose.yaml`, `pnpm hatchet:up`) and the engine in CI are Kyu's test infrastructure; this page does not cover them.

Each environment has three Fly resources:

- the engine app `<engine-app>`: `hatchet-lite` (engine, REST API, dashboard and gRPC server in one process) on one machine, with a config volume;
- the RabbitMQ app `<rabbitmq-app>`: the engine's internal queue, on one machine with a data volume and no public address;
- the managed Postgres cluster `<engine-db>`: the engine's own database, not your application's.

Placeholders in angle brackets stand for your names and ids: `<fly-org>`, `<region>`, `<engine-app>`, `<rabbitmq-app>`, `<engine-db>`, `<engine-cluster-id>`, `<company-domain>`. Keep the real values in your password manager. The cluster id changes when a cluster is recreated; read the current one with names only: `fly mpg list -o <fly-org>`, the row named `<engine-db>`.

## Copy the template

1. Copy `infra/hatchet/fly/` from the Kyu release tag that matches your SDK version (`v<version>` in [`kyuworks/kyu`](https://github.com/kyuworks/kyu)) into your repository, at the same path, so the commands on this page work as written. Take `fly.toml`, `secrets.sh`, `token.sh`, `rabbitmq/fly.toml` and `rabbitmq/secrets.sh`. The `*.test.sh` files check Kyu's copy against this page; you do not need them. The next release after v0.1.0 is the first whose template matches this page; the v0.1.0 template still carries the old comments.
2. The engine image tag in `fly.toml` is the one Kyu's CI tested that SDK version against. Do not change it except by the steps in *Upgrade*.
3. Choose these before the first deploy; the template's values are a starting point:
   - **Region.** The template uses `syd`. To use another, change `primary_region` in both `fly.toml` files and use the same `<region>` in every command below. Volumes and the cluster must be in the same region as the machines.
   - **Retention.** `168h` (7 days) suits dev. Set `720h` (30 days) in your production copy. See *Retention*.
   - **Machine sizes.** `performance-2x` for the engine and `performance-1x` for RabbitMQ. See *Sizing*.
   - **Volume names.** `kyu_hatchet_config_2x` and `kyu_rabbitmq_data`. If you rename one, change the `source` under `[[mounts]]` in that `fly.toml` and the commands below together.

## Who does what

- **The operator** is the person in your application's team who holds its Fly organisation and its password manager entries. The operator sets every secret, is the only one who runs `fly ssh issue` for the organisation, signs in to the engine's dashboard as its admin, creates bus tenants and mints tokens.
- **An engineer** creates Fly resources, writes config, deploys and checks the result. An agent may do the parts that touch no secret.
- **An agent never** reads a secret back, signs in to Fly or to the dashboard, or mints, reads or prints a token.

## First deploy

1. Create the engine app: `fly apps create <engine-app> -o <fly-org>`
2. Allocate a dedicated IPv4: `fly ips allocate-v4 -a <engine-app>` (about US$2 a month). Fly's shared IPv4 serves only ports 80 and 443; the engine's gRPC service listens on 7077, and without a dedicated IPv4 no worker can reach it. `fly ips list -a <engine-app>` must show a `v4` row of type `public`, not `shared`.
3. Create the engine's database cluster: `fly mpg create -o <fly-org> -n <engine-db> -r <region> --plan Basic --pg-major-version 17 --volume-size 10`. It starts on Basic; change the plan in the Fly dashboard (see *Sizing*).
4. Create the config volume, **before** the secrets and before the first deploy:
   `fly volumes create kyu_hatchet_config_2x -r <region> --vm-size performance-2x -a <engine-app>` (1 GB unless you choose a size).
   `fly deploy` does not create the volume `fly.toml` mounts, so it must exist first. The name must equal the `source` under `[[mounts]]` in `fly.toml`. It must be in the machine's region; a volume in another region cannot attach. The engine generates its own encryption keysets and cookie secrets into `/config` on first boot, so with no volume attached those keys land on the machine's temporary disk, and every worker token minted against them dies with that machine.
5. Set up RabbitMQ now: *Queue on RabbitMQ*, "First deploy of RabbitMQ", steps 1 to 5. `fly.toml` sets `SERVER_MSGQUEUE_KIND = 'rabbitmq'`, and the engine exits at boot with `could not init rabbitmq`, restarting in a loop, when it cannot reach the broker.
6. The operator stages the engine's secrets. Open the cluster's page in the Fly dashboard and copy the **direct** connection string, not the pooler: Hatchet needs a session-mode connection for LISTEN/NOTIFY, prepared statements and advisory locks, and a transaction pooler breaks all three. Run `bash infra/hatchet/fly/secrets.sh` to print every command, fill in each placeholder from the password manager, and run the `fly secrets set --stage ...` commands it prints. There is no `fly mpg attach` step. Eight secrets are required:
   - `DATABASE_URL`: the direct connection string. It needs no `sslmode` parameter.
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`: the dashboard admin. Use a lower-case `<company-domain>` address. The password must be 8 to 64 characters with an upper-case letter, a lower-case letter and a number, or the engine's seed refuses it and logs an error.
   - `SERVER_MSGQUEUE_RABBITMQ_URL`: `amqp://<user>:<pass>@<rabbitmq-app>.internal:5672/`, from the two RabbitMQ values.
   - `SERVER_URL`, `SERVER_AUTH_COOKIE_DOMAIN`, `SERVER_GRPC_BROADCAST_ADDRESS`: the engine's public address, see *Deployment values are secrets*.
   - `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS`: `<company-domain>`. The engine checks it at login as well as at signup, and the match is exact, so the admin's address must be on it.

   The script's `Optional overrides` block covers the four keyset and cookie secrets, which the engine otherwise generates into the volume from step 4.

   How the admin account comes to exist (engine source at v0.107.0, `cmd/hatchet-admin/cli/seed/seed.go` and `pkg/config/database/config.go`): the seed reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` at every boot. On an empty database it creates the boot tenant and the `ADMIN_EMAIL` user in the same boot and makes that user the tenant's Owner. It creates the user only when no user has that email, and it never changes an existing user's password. The engine has no way to change a user's email, only the password. With neither variable set, the seed creates the image's documented default account (the comment at the top of `infra/hatchet/compose.yaml`); the old names `SERVER_AUTH_ADMIN_EMAIL` and `SERVER_AUTH_ADMIN_PASSWORD` are ignored. So stage both before the first deploy. If the first boot ran without them, destroy the cluster, create an empty one with the step 3 command, stage the new `DATABASE_URL` (step 6) and deploy (step 7); the config volume and RabbitMQ stay.
7. Deploy: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`
8. Check health: `curl -s https://<engine-app>.fly.dev/api/ready` returns 200.

   If a worker's gRPC connection on 7077 fails with a TLS handshake error ("no application protocol") or a `502` or "invalid HTTP version", that is not `SERVER_GRPC_INSECURE`; it is the port's handler list in `fly.toml`. A bare `handlers = ['tls']` never offers an ALPN protocol on a `*.fly.dev` hostname (check with `openssl s_client -connect <engine-app>.fly.dev:7077 -alpn h2`), so grpc-js's TLS handshake fails before it starts. `handlers = ['tls', 'http']` fixes that, but then Fly forwards to the backend as HTTP/1.1, which the gRPC (h2c) server cannot parse. The template already has the fix: `handlers = ['tls', 'http']` plus `[services.ports.http_options] h2_backend = true`, which makes Fly forward HTTP/2.
9. Check sign-in. The admin signs in to `https://<engine-app>.fly.dev` with `ADMIN_EMAIL` and sees the tenant. A signup with any address is refused; the dashboard shows a generic internal-error toast, not a reason. The operator reports only "it worked" or "it did not".

   `SERVER_ALLOW_SIGNUP = 'f'` in `fly.toml` refuses every signup (the local form and both OAuth starts) before the domain check runs. `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS` stays as the second layer and still applies at login. To admit a new user: set `SERVER_ALLOW_SIGNUP` to `'t'`, deploy, have them sign up with a company address, set it back to `'f'` and deploy again. Tenant limits, including the worker limit, are off: `SERVER_ENFORCE_LIMITS` is unset, the engine's default.
10. The operator runs `fly ssh issue` once for the organisation, if that has not been done.
11. Check one worker end to end, against the boot tenant (the tenant the seed created at first boot). The operator mints a token for it: `export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/fly/token.sh -a <engine-app>)"`. `token.sh` defaults to the boot tenant's id, `707d0855-80ab-4e1f-a156-f1c4546cbf52`: hatchet-lite seeds the same id on every engine, as the boot log line `created tenant tenant_id=...` shows. If a re-seed ever produces another id, read it from the dashboard's address bar (*A bus tenant for each project*, sub-step 4) and pass `--tenant-id`. In the same shell set `HATCHET_CLIENT_API_URL=https://<engine-app>.fly.dev` and `HATCHET_CLIENT_HOST_PORT=<engine-app>.fly.dev:7077`, leave `HATCHET_CLIENT_TLS_STRATEGY` unset (it defaults to `tls`), start any Kyu worker (the one in [`first-consumer.md`](first-consumer.md) section 7), and confirm it appears under **Workers** in the dashboard.

    Then give no project the boot tenant: it holds the check worker above; give each project its own. Create a bus tenant for your application first.

## A bus tenant for each project

A tenant on your engine is for your application, one per environment. Another project that must receive your messages gets its own tenant on your engine, so its worker token cannot see your runs or any other project's (design § 6.2). That token goes to that project's operator through that project's secret store, never through yours. How messages cross between projects stays as the design says: an explicit relay, never a shared tenant. Repeat this for each tenant and environment. The operator does sub-steps 1 to 7, signed in to the dashboard as the admin from *First deploy* step 6. Engine facts below are from the engine's source at v0.107.0.

1. Check the engine allows it: `curl -s https://<engine-app>.fly.dev/api/v1/meta` shows `"allowCreateTenant":true`. Signup being off does not block this: the tenant-create handler checks only `SERVER_ALLOW_CREATE_TENANT`, which is on by default and not set in `fly.toml`, and `SERVER_ALLOW_SIGNUP` guards only new users (`api/v1/server/handlers/tenants/create.go:20`, `api/v1/server/handlers/users/create.go:26`, `pkg/config/server/server.go:238-247`).
2. Name it `<project>-<env>`, for example `<project>-dev`: lower-case letters, digits and `-`.
3. Create it in the dashboard: open the tenant switcher at the top right (it shows the current tenant's name), choose **New Tenant**, type the name under **Tenant Name**, and press **Get started**. The dashboard opens the new tenant's Overview. The signed-in user becomes the tenant's only Owner (`tenants/create.go:88-92`); invite anyone else from that tenant's **Settings > Members**. The dashboard adds `-` and up to five random characters to the tenant's slug; workers do not use the slug, and the switcher shows the name.

   Or through the API, from a bash shell with `jq` (run this in bash, not zsh: `read -p` is bash-only):

   ```bash
   ENGINE=https://<engine-app>.fly.dev
   ADMIN_EMAIL=<admin-email>
   TENANT=<project>-<env>
   JAR="$(mktemp)"
   read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
   jq -n --arg email "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" '{email: $email, password: $password}' |
     curl -s -c "$JAR" -o /dev/null -w 'login %{http_code}\n' -X POST "$ENGINE/api/v1/users/login" \
       -H 'Content-Type: application/json' --data-binary @-
   unset ADMIN_PASSWORD
   jq -n --arg name "$TENANT" '{name: $name, slug: $name}' |
     curl -s -b "$JAR" -X POST "$ENGINE/api/v1/tenants" -H 'Content-Type: application/json' --data-binary @- |
     jq '{id: .metadata.id, name, slug, errors}'
   rm -f "$JAR"
   ```

   `login 200` means signed in; any other code means sign-in failed and the rest prints nulls. A slug already in use shows `Tenant with that slug already exists.` under `errors` (`tenants/create.go:33-45`). A worker token cannot create a tenant: the engine answers 403 (`api/v1/server/authn/middleware.go:310`).
4. Read the tenant id from the dashboard's address bar while the new tenant is selected: it is the part after `/tenants/` (`/tenants/<id>/overview`). **Settings > General** does not show it. The API block prints it as `id`. Record the name and id in your password manager. The tenant's own project keeps them beside its token entry in its secret store.
5. Mint the project's worker token with `bash infra/hatchet/fly/token.sh -a <engine-app> --tenant-id <id>`, sending its output straight into the secret store of the project the tenant is for (for another project, that project's, never yours), never to the screen, a file or chat. For another project, ask that project's operator to grant you write access to one entry in its store, or hand the token to that operator through your company's secret-sharing route, never through chat or a ticket; choose one and say which in your operations notes. The operator, or an engineer the operator has given an SSH certificate for the organisation, runs it (*First deploy* step 10). A token lasts 90 days (`cmd/hatchet-admin/cli/token.go:65`): note the date and mint a new one before then, or turn on expiring-token alerts (*Turning on failure alerts*). Each mint adds a token named `default` under that tenant's **Settings > API Tokens**, where an old one can be revoked. Check the command's exit status, since the output is not shown: non-zero means no token. On the local stack a mistyped id exits 1 with `violates foreign key constraint` on stderr. On Fly, `token.sh` keeps only the last output line, so a failed mint may leave an error line in the secret store. If the exit status was non-zero, fix the id and mint again rather than trusting the stored value.
6. Give the project's operator its tenant name and id, and tell them the token is in their secret store. That project sets the variables in [`first-consumer.md`](first-consumer.md) section 8 and keeps its own namespace.
7. Confirm: once the project's worker has started with that token, select the new tenant in the switcher and open **Workers**. The worker is listed, its name starting with the project's namespace. Select the boot tenant: the worker is not listed there. The operator reports only "it worked" or "it did not".
8. What is per tenant and what is engine-wide:

   | Per tenant | Engine-wide, the same for every tenant |
   |---|---|
   | worker tokens, workers, workflows and runs, the dashboard view, members, alert switches (failed runs, expiring tokens) | retention (`SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD`, *Retention*) |
   | the project's namespace, which only separates processes inside one tenant | limits: the engine writes default limits for the new tenant (`tenants/create.go:83`) but enforces none, because `SERVER_ENFORCE_LIMITS` is unset |
   | | user accounts, signup and the company-domain restriction, tenant creation (`SERVER_ALLOW_CREATE_TENANT`), the Slack app for alerts |
   | | the machine, the database cluster and RabbitMQ: one project's load slows every tenant |

9. A tenant cannot be removed at v0.107.0: no dashboard page or API call deletes one (the API spec's tenant paths delete only invites, members and alert email groups, `api-contracts/openapi/paths/tenant/tenant.yaml`). A tenant made by mistake stays; rename it under **Settings > General** and revoke its tokens.
10. Rehearse on the local stack first (same image tag). From a Kyu checkout, run `pnpm hatchet:up`, sign in at `http://localhost:8888` with the account in the comment at the top of `infra/hatchet/compose.yaml`, and do sub-steps 3 and 4 with the name `rehearsal-<date>` (for the API block, set `ENGINE=http://localhost:8888` and that account's email). Then:

    ```bash
    export HATCHET_CLIENT_TOKEN="$(KYU_HATCHET_TENANT_ID=<id> bash infra/hatchet/token.sh)"
    export HATCHET_CLIENT_TLS_STRATEGY=none
    ```

    Start any Kyu worker in that shell (the worker in [`first-consumer.md`](first-consumer.md) section 7) and do sub-step 7. Keep this shell's `HATCHET_CLIENT_TOKEN`: a worker started with a boot-tenant token lands under the boot tenant and sub-step 7 fails. Local tenants cannot be removed either, and `pnpm hatchet:down` keeps them.

    On the local stack, a rehearsal shows: a tenant created from the dashboard or the API block comes back with a new id and the admin as its Owner; a worker started with a token minted for it is listed under the new tenant and not under the boot tenant; the same token gets 403 reading the boot tenant's workers; a worker token gets 403 creating a tenant; a reused slug gets 400; a made-up id fails the mint with the foreign key error.

## Deployment values are secrets

`fly.toml` carries no app name, and four engine settings live in Fly secrets instead, so the file can be public: `SERVER_URL` (`https://<engine-app>.fly.dev`), `SERVER_AUTH_COOKIE_DOMAIN` (`<engine-app>.fly.dev`), `SERVER_GRPC_BROADCAST_ADDRESS` (`<engine-app>.fly.dev:7077`) and `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS`. `bash infra/hatchet/fly/secrets.sh` prints the commands, and `fly secrets list -a <engine-app>` shows all eight names (names only). A secret takes priority over an `[env]` value of the same name. Every `fly` command passes `-a`, because `fly.toml` names no app.

## Sizing

**Database plan.** Run the engine's cluster on Launch or larger for load like the shop example's report-size failure harness. The database holds the engine's own state (task and run records, concurrency, run history) even with the queue on RabbitMQ. Measured in September 2026 on a deployment of this template (`docs/proofs/2026-09-23-shop-failure-harness-fly-dev.md`; archived issues 173, 175, 176 and 198):

- On Launch, with the queue on RabbitMQ and the harness's own database cluster also on Launch, both report-size scenarios met their windows.
- On Basic, with the queue on RabbitMQ, a smoke-size run passed both scenarios, but at report size `tenant-load` failed after about 36 minutes and `outbox-backlog` drained about 44 rows a second, against about 976 on Launch. From about two minutes into `tenant-load` the engine lost its connections to the cluster (`failed to connect` lines, almost all `unexpected EOF`, no connection-slot error), and the Fly dashboard showed the cluster's CPU throttled. That is one run. The log also showed recovery and read-only lines and an administrator terminating connections, which nobody checked, so the cause is not established.
- With the queue on Postgres, the report-size `tenant-load` on Starter missed both its windows with hundreds of queue errors in the engine log, and passed with none once both clusters moved to Launch. Starter has not been measured with the queue on RabbitMQ.

**Engine machine.** hatchet-lite runs the API, dashboard, gRPC server and queue workers in one process. `shared-cpu-2x`'s 512 MB does not fit that comfortably under load, and shared-CPU throttling distorts latency, hence `performance-2x` in the template. See *Resizing the engine machine*.

## Retention

The engine keeps run and event history in daily partitions and drops a whole day once it is older than `SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD`. That covers runs, task events, events, logs and payloads, and applies to every tenant on the engine (hatchet v0.107.0). It is an env var in `fly.toml`, not a dashboard or API setting. The per-tenant "data retention period" the engine stores is used only for old-worker cleanup, which is off. The value is a Go duration.

- The template sets `168h` (7 days), suitable for dev.
- Production: `720h` (30 days). This is also the engine's default, but set it explicitly in that environment's `fly.toml`. Kyu's outbox prune floor assumes 30 days (`pruneOutbox`, [`first-consumer.md`](first-consumer.md) section 3).
- A partition is dropped only once the whole UTC day it holds is older than the period (strict `<`), so the first drop comes one period plus up to a day after the first partition. `fly logs -a <engine-app>` then shows `removing partitions before … using retention period of 168h0m0s`.
- The engine refuses to boot on a value it cannot parse, so a healthy `/api/ready` after the deploy means the value was accepted.
- `SERVER_LIMITS_CORE_PARTITION_RETENTION` and `SERVER_LIMITS_OLAP_PARTITION_RETENTION` override this value for the core and OLAP tables separately when set; leave both unset so one value governs everything.

## Turning on failure alerts

Optional. The engine can post to Slack when a run fails and when a worker token is about to expire. A failed run is the dead letter, so without alerts someone has to watch the dashboard. Nothing on the Kyu side sends alerts for you.

What an alert carries: the workflow name, the time, and a link with the tenant and run ids. No payloads, error text or logs (engine source at v0.107.0, `internal/integrations/alerting/slack.go:59-69`).

1. The operator creates a Slack app in your workspace with the `incoming-webhook` scope, and sets its OAuth redirect URL to `https://<engine-app>.fly.dev/api/v1/users/slack/callback`.
2. The operator stages the app's client id and client secret as engine secrets, `SERVER_TENANT_ALERTING_SLACK_CLIENT_ID` and `SERVER_TENANT_ALERTING_SLACK_CLIENT_SECRET`. These names are those of engine v0.107.0 and may change with the tag you run. An engineer adds both names to your copy of `secrets.sh` with `<REPLACE_ME>` values, and `SERVER_TENANT_ALERTING_SLACK_ENABLED = 't'` under `[env]` in your copy of `fly.toml`. Deploy.
3. The operator, signed in to the dashboard, links a channel for each tenant that should alert: open `https://<engine-app>.fly.dev/api/v1/tenants/<tenant-id>/slack/start` in that browser and finish Slack's install flow. `GET /api/v1/tenants/<tenant-id>/slack` then lists the webhook. The engine saves a webhook only through this flow.
4. Switch the alerts on for that tenant, in the tenant's settings in the dashboard, or with `PATCH /api/v1/tenants/<tenant-id>` and `{"enableWorkflowRunFailureAlerts": true, "enableExpiringTokenAlerts": true}`. A worker token for that tenant can make this call. `GET /api/v1/tenants/<tenant-id>/alerting/settings` reads the result, including `maxAlertingFrequency`.
5. Prove it: fail one run on purpose. One message arrives, carrying only the workflow name, the time and a link with ids.

Costs to expect: at most one message per `maxAlertingFrequency` (one an hour), and the first after switching on covers the previous day. Tests that fail runs on purpose against this engine alert too. There is no route without a new secret: email alerting needs SMTP secrets. If your workspace will not allow the app, poll for failed runs instead (`kyu.runs` in the SDK README).

## Upgrade

Kyu moves the engine tag first. In one Kyu pull request, the tag changes in all four places that name it: the default in `infra/hatchet/compose.yaml`, the template's `infra/hatchet/fly/fly.toml`, and the `hatchet-lite` service image in `.github/workflows/ci.yml` and `.github/workflows/newest-client.yml`. `scripts/gates/check-engine-image-tag.sh` fails that pull request and names any file still on the old tag, and the integration suites run on the new tag in CI. The shop example checks its own workflows against the compose tag, so it changes there too. Before choosing a new tag, Kyu's maintainers read the latest run of `.github/workflows/newest-engine.yml`: it runs the test suites against the newest `hatchet-lite` release every week, and a red run there is a signal to read before upgrading. It picks its tag at run time, so an upgrade does not change that file.

Then the operator moves your copy, environment by environment:

1. Take a snapshot: `fly mpg backup list <engine-cluster-id>` and, if the platform does not take one automatically, trigger one first with `fly mpg backup create <engine-cluster-id>`.
2. Change the tag in your copy of `fly.toml` to the one in the Kyu release whose SDK you install.
3. Deploy dev: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`. Hatchet migrates its schema on start.
4. Soak for a day: watch the dashboard, worker logs and `/api/ready` for anything unusual.
5. Only then deploy the same tag to the next environment.
6. Check every entry under *Known engine defects* against the new release before promoting it.

### Known engine defects

**v0.107.0: the run list keeps an ended run as queued or running.** Seen on the local engine and on a deployed engine (archived issues 165 and 170). Not reproducible from a fresh namespace; it follows the engine stopping between writing its own state and the list's copy. The SDK's run readers read the engine's run detail for such runs (README). Evidence, queries and what to raise upstream: `docs/proofs/2026-09-23-engine-run-list-stale-rows.md`. Kyu drops this entry only once that page's queries come back empty after a load run on a new release.

## Resizing the engine machine

1. `fly machine update <engine-machine-id> --vm-size <size> -a <engine-app>` can be refused with "insufficient memory available to fulfill request on the current host"; the update reverts without a restart. After a successful `fly machine update`, also change `size` under `[[vm]]` in your `fly.toml`, or the next deploy reverts the machine.
2. If it is refused, fork and clone (the operator runs this), in this order: stop the old machine; fork its config volume under a new name, `fly volumes fork <config-volume-id> -a <engine-app> -n <new-config-volume> --vm-size <size>`; clone the machine onto the forked volume, `fly machine clone <engine-machine-id> -a <engine-app> --attach-volume <new-volume-id>:/config --vm-size <size>`; then change `fly.toml`'s `source` and `size` to match. The fork copies `/config`, so existing worker tokens keep working.
3. **Never run two engine machines against one cluster.** With two running, a small cluster refuses connections ("remaining connection slots are reserved…", "too many clients"). Stop the old machine first.
4. To roll back while the old machine still exists: `fly machine stop <new-machine-id> -a <engine-app>`, wait for `stopped` in `fly machine list -a <engine-app>`, `fly machine start <engine-machine-id> -a <engine-app>`, and revert `fly.toml`'s `source` and `size`.
5. Do not `fly deploy` the engine while both machines exist: flyctl replaces a machine whose volume name differs from `fly.toml` (`internal/command/deploy/machines_launchinput.go`), which would start a second engine against the same cluster. Once the new machine is healthy, the operator destroys the old machine and, when sure, its volume. The rollback path goes with them.

## Backup and restore rehearsal

1. List available backups: `fly mpg backup list <engine-cluster-id>`
2. Restore into a **new** cluster, never onto the live one: `fly mpg restore <engine-cluster-id> --backup-id <backup-id> -n <destination-name>`, with a destination name that does not exist yet. The command returns at once; the new cluster reads `creating` in `fly mpg list -o <fly-org>` until `ready`, about 3.5 minutes for a small cluster. Confirm the source cluster stays `ready` throughout.
3. Point a scratch app's `DATABASE_URL` at the restored cluster and confirm the engine starts and the dashboard shows the expected run history. Without this step the restore is proven to complete, not to hold readable data.
4. Record the date and what was restored in your own operations notes, then destroy the restored cluster.

## When the engine is unhealthy

Work through these in order:

1. `fly status -a <engine-app>`: is a machine running at all, and how long has it been up? The engine generates its encryption keysets and cookie secrets into `/config/server.yaml` on first boot and reuses them while the config volume stays attached, so a restart or a replacement of the machine with that volume attached keeps previously minted worker tokens working. A replacement with the volume missing or in the wrong region does not: the engine generates a fresh set of keys. The alternative is setting `SERVER_ENCRYPTION_MASTER_KEYSET`, `SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET`, `SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET` and `SERVER_AUTH_COOKIE_SECRETS` as secrets so the keys live in the environment instead of the volume (`secrets.sh`, optional block).
2. `fly logs -a <engine-app>`: look for a crash loop, a database connection error, or a migration failure at start. The lines `Generating encryption keys for Hatchet server` and `Generating config files ./config` are printed on every boot; they do not mean new keys were written.
3. `curl -s https://<engine-app>.fly.dev/api/ready`: is the API answering at all? A 200 there does not mean the REST API is ready: after a restart, run reads have answered 500 for several minutes. Wait 10 minutes, or run a small smoke check, before putting load on it.
4. `fly mpg status <engine-cluster-id>`: is the database cluster healthy? This prints connection details, so the operator runs it, not an agent.
5. Check the volume: has the machine been replaced? A replacement with no volume attached, or a volume in the wrong region, means `/config` starts empty and the engine generates a fresh keyset, so every token minted before is dead. Mint new ones (*A bus tenant for each project*, sub-step 5).
6. If nothing above explains it, re-read *First deploy* for anything skipped or done out of order, then ask the operator to check that all eight secrets are set.

## Queue on RabbitMQ

The engine's internal queue runs on RabbitMQ in every deployed environment ([ADR](../architecture/adr/20260925-engine-queue-runs-on-rabbitmq.md)). On Fly, every Postgres-queue setup measured missed the `outbox-backlog` window, and on RabbitMQ with the cluster on Launch both load scenarios met theirs (`docs/proofs/2026-09-23-shop-failure-harness-fly-dev.md`). Kyu's local stack and CI keep the Postgres queue.

hatchet-lite (`cmd/hatchet-lite/main.go` at v0.107.0) forces the Postgres queue only when none of the four queue variables is set: `SERVER_MSGQUEUE_KIND`, `SERVER_MSGQUEUE_RABBITMQ_URL`, and the legacy `SERVER_TASKQUEUE_KIND` and `SERVER_TASKQUEUE_RABBITMQ_URL`. `<rabbitmq-app>` has no public address and no management UI: from outside the private network it is reached only through `fly machine exec`.

**First deploy of RabbitMQ** (an engineer does steps 1, 2, 4 and 5; the operator does step 3):

1. Create the app: `fly apps create <rabbitmq-app> -o <fly-org>`
2. Create the data volume, in the same region, before any deploy: `fly volumes create kyu_rabbitmq_data -r <region> -s 3 -a <rabbitmq-app> --vm-size performance-1x`. The `--vm-size` flag places the volume on a host that can fit a `performance-1x` machine; a volume placed without it can hit "insufficient memory available to fulfill request on the current host".
3. **Before step 4**, the operator runs `bash infra/hatchet/fly/rabbitmq/secrets.sh` and the two `fly secrets set --stage` commands it prints, filling in `RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS` (letters and digits only, so the engine's URL needs no escaping). RabbitMQ reads both only on its first boot with an empty data volume; if step 4 runs first, RabbitMQ creates a `guest` account that this image lets connect from other machines on the private network. If that happens, destroy the machine and volume and restart at step 2.
4. Deploy: `fly deploy -c infra/hatchet/fly/rabbitmq/fly.toml -a <rabbitmq-app> --ha=false`
5. Check: `fly checks list -a <rabbitmq-app>` shows the `amqp` check passing; `fly logs -a <rabbitmq-app> --no-tail` shows `started TCP listener on [::]:5672` and `Server startup complete` (the `[::]` matters: Fly's private network, 6PN, is IPv6 only); `fly ips list -a <rabbitmq-app>` is empty. The operator runs `fly machine exec <id> 'rabbitmqctl -n rabbit@localhost -q list_users' -a <rabbitmq-app>` (it prints the user name, so only the operator runs it) and confirms it lists exactly one user and no `guest`.

Then go back to *First deploy* step 6.

**What connected looks like:** with `SERVER_MSGQUEUE_KIND = 'rabbitmq'` the engine dials RabbitMQ before it starts serving and exits if it cannot (`pkg/config/loader/loader.go`), so `/api/ready` answering 200 already means the engine is connected. The engine's log since the deploy has no `cannot (re)dial` line (the URL is printed with the password masked) and no `Creating new Postgres message queue` line. RabbitMQ's log shows `accepting AMQP connection` lines, each followed by `authenticated and granted access`, all from the engine's private address. The operator can also run `fly machine exec <id> 'rabbitmqctl -n rabbit@localhost -q list_connections peer_host state' -a <rabbitmq-app>` and see connections from the engine's private address (`fly machine list -a <engine-app>`), all `running`; `list_queues name messages consumers` lists Hatchet's queues with consumers attached. Watch `fly logs -a <rabbitmq-app>` for any `alarm` line (memory or disk): it means RabbitMQ blocked the engine's publishes. Read RabbitMQ's connection lines yourself rather than pasting them: they print the user name. hatchet-lite rewrites `/config/server.yaml` with the RabbitMQ URL on every boot, the same way it holds `DATABASE_URL`.

**Switching back to the Postgres queue**, in an emergency only (staying on it needs a new ADR): set `SERVER_MSGQUEUE_KIND = 'postgres'` in your copy of `fly.toml`, confirm no load is running (runs already queued stay on the queue they were queued on), and `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`. The `SERVER_MSGQUEUE_RABBITMQ_URL` secret can stay set; hatchet-lite ignores it once the kind is `postgres`. Check that `list_connections` on `<rabbitmq-app>` shows nothing from the engine any more.
