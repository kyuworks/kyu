# Running the Kyu engine on Fly

This page covers the deployed Hatchet engine for the Kyu message bus: `infra/hatchet/fly/`
(issue #162). It does not cover the local stack — see `infra/hatchet/compose.yaml` and
`infra/hatchet/token.sh` for that.

Placeholders in angle brackets stand for this deployment's real names and ids. The real values live
in the operator's password manager.

Today there is one environment: dev, org `<fly-org>`, region `syd`. What exists on Fly for it
as of 2026-09-27:

- the engine app `<engine-app>`, machine `<engine-machine-id>` (`performance-2x`, 4 GB), config
  volume `kyu_hatchet_config_2x` (`<engine-config-volume-id>`), queue on RabbitMQ;
- the RabbitMQ app `<rabbitmq-app>`, machine `<rabbitmq-machine-id>` (`performance-1x`), data volume
  `<rabbitmq-volume-id>`, no public IP address;
- the engine's database cluster `<engine-db>` (cluster id `<engine-cluster-id>`), on Basic.

The shop harness app and its cluster were destroyed on 2026-09-25; the shop example's
`docs/harness-on-fly.md` (`kyuworks/shop-example`) says how to recreate them.

Commands on this page write the engine's cluster id as `<engine-cluster-id>`, because a recreated
cluster gets a new id. Read the current id with names only: `fly mpg list -o <fly-org>`, the row
named `<engine-db>`. The id above is a dated record; when the cluster is recreated, update it with
the new id and the date.

The engine has run on machine `<engine-machine-id>` since 2026-09-23 (issue #173). The `performance-1x`
rollback machine `<old-engine-machine-id>` and its volume `<old-engine-volume-id>` were destroyed on
2026-09-23 before the queue switch (issue #176), so the rollback path in "Resizing the engine
machine" no longer exists; the rollback for the queue switch is the `SERVER_MSGQUEUE_KIND`
setting. Cluster plan: Basic since 2026-09-24, moved down from Launch by the CTO for the issue #198
run (Basic until 2026-09-23, then Starter, then Launch the same day).

Queue: RabbitMQ (`<rabbitmq-app>`) since 2026-09-23 (issue #176), on the same machine and
volume; the Postgres queue before that. RabbitMQ stays, see
[`20260925-engine-queue-runs-on-rabbitmq.md`](../architecture/adr/20260925-engine-queue-runs-on-rabbitmq.md).
Harness numbers on both: `docs/proofs/2026-09-23-shop-failure-harness-fly-dev.md`.

**Database plan.** Run the engine's cluster on Launch or larger. On the Postgres queue, Hatchet
Lite kept its internal queue in this database, so the plan set the engine's ceiling under load: on
Starter the report-size `tenant-load` missed both windows with hundreds of queue errors in the
engine log; with only the database plans changed (both clusters, engine's and shop's, moved from
Starter to Launch together), it passed with none
(`docs/proofs/2026-09-23-shop-failure-harness-fly-dev.md`, issues #173 and #175). A cluster
created by the command in First deploy starts on Basic; the plan is changed in the Fly
dashboard. With the queue on RabbitMQ the database still holds the engine's own state: task and
run records, concurrency, run history. On 2026-09-24 (issue #198), with only the engine's cluster
moved from Launch to Basic, a smoke-size run passed both scenarios, but at report size
`tenant-load` failed after about 36 minutes and `outbox-backlog` drained about 44 rows a second,
against about 976 on Launch. From about two minutes into `tenant-load` the engine lost its
connections to the cluster (55,172 `failed to connect` error lines, almost all `unexpected EOF`,
no connection-slot error), and the CTO saw the cluster's CPU throttled in the Fly dashboard. This
fits the limit moving from the queue tables to the engine's own state writes; one run, and the log
also shows lines saying the database was in recovery, in a read-only transaction and terminating a
connection on an administrator command (09:57Z–10:21Z), which was not checked.

**Before a report-size harness run, have both clusters on Launch.** The engine's cluster is on
Basic since 2026-09-24 (after issue #198). Basic failed at report size (issue #198) and Starter has
not been tried with the queue on RabbitMQ; the only report-size run that passed had both clusters
on Launch (issue #176), so move the engine's cluster to Launch first, and put a recreated shop
cluster on Launch too. A smoke-size run passes with the engine's cluster on Basic (issue #198). A
shop cluster on Basic with the queue on RabbitMQ has not been measured at report size.

## Who does what

- The CTO sets every secret and is the only one who runs `fly ssh issue` for the org. No agent
  reads a secret back or signs in to Fly.
- An engineer (or an agent, for the parts that do not touch a secret) creates Fly resources,
  writes config, deploys, and checks the result.
- The CTO does the rebuild in step 11. The signup restriction went live with the sub-step 3 deploy
  on 2026-09-27 — see the dated paragraph at the end of step 11. Signup itself is now off
  (`SERVER_ALLOW_SIGNUP = 'f'`); admitting a new user is a CTO step, below.
- The CTO creates each project's bus tenant (step 12), signed in to the dashboard as the
  company-domain admin, and is its only Owner until they invite someone. The CTO, or an engineer
  the CTO has given an SSH certificate for the org, mints its token straight into the project's
  secret store. An agent never signs in to the dashboard.

## First deploy

1. Allocate a dedicated IPv4: `fly ips allocate-v4 -a <engine-app>` (about US$2/month). Fly's
   shared IPv4 only serves ports 80 and 443; the engine's gRPC service listens on 7077, and without
   a dedicated IPv4 no worker can reach it. Confirmed needed on first deploy (issue #162 PR B):
   `fly ips list -a <engine-app>` must show a `v4` row of type `public`, not `shared`.
2. Create the app: `fly apps create <engine-app> -o <fly-org>`
3. Create the managed Postgres cluster: `fly mpg create -o <fly-org> -n <engine-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10`
4. Create the config volume, **before** the secrets step and before the first deploy —
   `fly deploy` does not create the volume `fly.toml` mounts, so it must exist first:
   `fly volumes create kyu_hatchet_config_2x -r syd -a <engine-app>` (size per the plan, or 1 GB
   if none is set). The name must equal the `source` under `[[mounts]]` in
   `infra/hatchet/fly/fly.toml`; `infra/hatchet/fly/config.test.sh` fails if they differ.
   It must be created in `syd`; a volume in another region cannot attach to a machine in `syd`.
   This has to come before the engine ever starts: the engine generates its own
   encryption keysets and cookie secrets into `/config` on first boot, so with no volume attached
   those keys land on the machine's ephemeral disk and every worker token minted against them
   dies with that machine.
5. The CTO opens the cluster's page in the Fly dashboard, copies the **direct** connection
   string (not the pooler — Hatchet needs a session-mode connection for LISTEN/NOTIFY,
   prepared statements and advisory locks, all of which a transaction pooler breaks), then runs
   `infra/hatchet/fly/secrets.sh` to see every command, fills in each placeholder — including
   `DATABASE_URL` with that string — from 1Password, and runs the `fly secrets set --stage ...`
   commands it prints. There is no `fly mpg attach` step here. Eight secrets are required
   (`DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
   `SERVER_MSGQUEUE_RABBITMQ_URL` while the queue is RabbitMQ — see *Queue on RabbitMQ* — and the
   four deployment values `SERVER_URL`, `SERVER_AUTH_COOKIE_DOMAIN`,
   `SERVER_GRPC_BROADCAST_ADDRESS` and `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS`); the
   script's `Optional overrides` block covers the four keyset and cookie secrets, which the engine
   otherwise generates itself into the volume created in step 4. Confirmed on first deploy: the
   direct connection string needed no `sslmode` parameter — the schema migration ran clean with no
   SSL error in the logs. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are read by the engine's seed at
   every boot. The seed creates that user only when no user has the email yet, and never changes
   an existing user's password. The password must be 8 to 64 characters with an upper-case
   letter, a lower-case letter and a number, or the seed refuses it and logs an error. Use a
   lower-case `<company-domain>` address: the domain staged as `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS` restricts signup and login,
   and the match is exact.
6. Deploy: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`
7. Check health: `curl -s https://<engine-app>.fly.dev/api/ready` should return 200. Confirmed
   through the edge on first deploy. If the gRPC port on 7077 fails with a TLS handshake error
   ("no application protocol") or a `502`/"invalid HTTP version" from a worker, that is not
   `SERVER_GRPC_INSECURE` — it is the port's handler list in `fly.toml`. A bare `handlers =
   ['tls']` never offers an ALPN protocol on a `*.fly.dev` hostname (confirmed directly with
   `openssl s_client -connect <engine-app>.fly.dev:7077 -alpn h2`), so grpc-js's TLS handshake
   fails before it starts; `handlers = ['tls', 'http']` fixes that but then Fly forwards to the
   backend as HTTP/1.1 by default, which the gRPC (h2c) server cannot parse. The fix already
   shipped in `fly.toml` is `handlers = ['tls', 'http']` plus `[services.ports.http_options]
   h2_backend = true`, which makes Fly forward HTTP/2 to the backend instead.
8. The CTO runs `fly ssh issue` once for the org, if that has not already been done.
9. Mint a worker token from this machine: `export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/fly/token.sh -a <engine-app>)"`.
   `token.sh` defaults to the tenant id the local stack seeds (`707d0855-80ab-4e1f-a156-f1c4546cbf52`).
   Confirmed on first deploy: this Fly instance seeded the same id (read off the engine's own boot
   log, `created tenant tenant_id=707d0855-...`), so the default works with no `--tenant-id`
   override. If a future re-seed ever produces a different id, read the real one from the
   dashboard's address bar (step 12, sub-step 4) and pass it with `--tenant-id`.
10. Register one worker against it (see the shop example's README, "Against the deployed dev
    engine") and confirm it shows up in the dashboard.
11. **Before leaving the dashboard reachable, confirm the admin login uses an account the CTO
    controls, not `hatchet-lite`'s own default.** Found on 2026-09-25: the CTO could not sign in
    with the values they had set. The engine's source at v0.107.0 explains why: its seed reads
    `ADMIN_EMAIL` and `ADMIN_PASSWORD`, and `secrets.sh` had staged the admin under two other
    names, which the engine ignores. With neither set, the seed creates the image's documented
    default account (the comment at the top of `infra/hatchet/compose.yaml`). The live database
    was not inspected. Two more engine facts shape the fix: the seed never changes an existing
    user, and v0.107.0 has no way to change a user's email, only the password. Signup was open
    (`/api/v1/meta` reported `allowSignup: true`).

    Done and decided on 2026-09-25 (issue #208): the CTO signed in with the documented default
    account and changed its password in the dashboard, so the image's default password no longer
    opened the dashboard. The CTO decided to do the rest of this step when the dev engine was torn
    down and recreated, not on the live database. Until then the default account, with its new
    password, was the tenant's only Owner, and signup stayed open. Superseded on 2026-09-27 — see
    below.

    So `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS` was not in `fly.toml` on `main` (issue #210), until
    the rebuild below put it back. The engine checks it at login as well as signup; deployed on
    the old database, it would have refused the default account and no one could reach the tenant
    or invite a new Owner. Until the rebuild's sub-step 3 below, no deploy from `main` had carried
    the setting, so merely being on `main` had not yet changed who could reach the tenant — that
    changed only once a deploy shipped it. `infra/hatchet/fly/config.test.sh` failed while the
    setting was in `fly.toml`, so it could not come back by accident before the database was
    replaced. If it had ever gone live on the old database, the CTO would have removed the setting
    (from `fly.toml`, or from the app's secrets if it was set there) and deployed again.

    At the rebuild, the CTO does these steps, in this order, as part of *First deploy* against a
    new, empty database. Agents do none of these steps.

    1. In *First deploy* step 5, stage a lower-case `<company-domain>` address as `ADMIN_EMAIL` and a
       password that meets the seed's rule as `ADMIN_PASSWORD` (run `secrets.sh` for the
       commands). Unset any admin secret the script no longer prints with `fly secrets unset
       --stage -a <engine-app> <NAME> ...` (`fly secrets list -a <engine-app>` shows names
       only).
    2. Only once the old database is gone, put the `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS` line
       back, as a secret set to the company domain (it moved out of `fly.toml` in the pre-public scrub, issue #2 (archived issue 223); see
       *Deployment values are secrets* below). From then on every deploy carries the setting.
    3. Deploy (*First deploy* step 6) with the setting in place. On an empty database the seed
       creates the tenant and the `ADMIN_EMAIL` user in the same boot and makes that user the
       tenant's Owner; with `ADMIN_EMAIL` set it never creates the image's default account
       (`cmd/hatchet-admin/cli/seed/seed.go` and `pkg/config/database/config.go` at v0.107.0). No
       invite is needed and there is no default account to remove.
    4. Confirm: a signup with a non-company address is refused, and the `<company-domain>` admin signs in
       and sees the tenant. The CTO reports only "it worked" or "it did not". That closes this
       step.

    Rebuilt on 2026-09-27: the CTO destroyed the old cluster, created a new empty one, staged the
    company-domain admin secrets and unset the two wrong admin names (sub-step 1), then deployed
    from `main` **without** the restriction. On the empty database the seed created the tenant
    (same id as before) and the company-domain admin as its Owner; no default account exists.
    That deploy was sub-step 2. One non-company address was created as a user during the check
    before the restriction deploy; it holds no tenant role and cannot sign in now that the
    restriction is live. Sub-step 3 — release v9, a deploy from `main` with the restriction in
    place — went out the same day. Sub-step 4 is confirmed: a signup with a non-company address
    is refused (the dashboard shows a generic internal-error toast, not a named reason), and the
    `<company-domain>` admin signs in and sees the tenant.

    Signup off (issue #224): from the next deploy, `SERVER_ALLOW_SIGNUP = 'f'` in `fly.toml`
    refuses every signup — the local form and both OAuth starts — before the domain check even
    runs. `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS` stays in place as the second layer and still
    applies at login. To admit a new user: set `SERVER_ALLOW_SIGNUP` to `'t'`, deploy, have them
    sign up with a company address, then set it back to `'f'` and deploy again. Limits: tenant
    limits, including the worker limit, are off (`SERVER_ENFORCE_LIMITS` is unset — the engine
    default). Retention: `168h` on dev — see *Retention* below.

12. **A bus tenant for each consuming project.** Each company project gets its own bus tenant (a
    Hatchet tenant) per environment, so its worker token cannot see another project's runs
    (design § 6.2). The tenant the seed created at first boot (step 9, the boot tenant) is not one
    of them: the shop example and its harness use it. Repeat this step for each project and
    environment. The CTO does sub-steps 1 to 7, signed in to the dashboard as the company-domain
    admin (step 11). An agent never signs in to the dashboard or to Fly, and never mints, reads or
    prints a token. Engine facts below are from the engine's source at v0.107.0.

    1. Check the engine allows it: `curl -s https://<engine-app>.fly.dev/api/v1/meta` shows
       `"allowCreateTenant":true`. Signup being off does not block this: the tenant-create
       handler checks only `SERVER_ALLOW_CREATE_TENANT`, which is on by default and not set in
       `fly.toml`, and `SERVER_ALLOW_SIGNUP` guards only new users
       (`api/v1/server/handlers/tenants/create.go:20`, `api/v1/server/handlers/users/create.go:26`,
       `pkg/config/server/server.go:238-247`).
    2. Name it `<project>-<env>`, for example `<project>-dev`: lower-case letters, digits and `-`.
    3. Create it in the dashboard: open the tenant switcher at the top right (it shows the current
       tenant's name), choose **New Tenant**, type the name under **Tenant Name**, and press **Get
       started**. The dashboard opens the new tenant's Overview. The signed-in user becomes the
       tenant's only Owner (`create.go:88-92`); invite anyone else from that tenant's **Settings >
       Members**. The dashboard adds five random characters to the tenant's slug; workers do not
       use the slug, and the switcher shows the name.

       Or through the API, from a shell with `jq`:

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
         jq '{id: .metadata.id, name, slug}'
       rm -f "$JAR"
       ```

       `login 200` means signed in. A slug already in use answers `Tenant with that slug already
       exists.` (`create.go:33-45`). A worker token cannot create a tenant: the engine answers 403
       (`api/v1/server/authn/middleware.go:310`).
    4. Read the tenant id from the dashboard's address bar while the new tenant is selected: it is
       the part after `/tenants/` (`/tenants/<id>/overview`). **Settings > General** does not show
       it. The API block prints it as `id`. Record the name and id in the operator password manager
       beside the project's token entry.
    5. Mint the project's worker token with
       `bash infra/hatchet/fly/token.sh -a <engine-app> --tenant-id <id>`, sending its output
       straight into the project's secret store, never to the screen, a file or chat. The CTO, or
       an engineer the CTO has given an SSH certificate for the org, runs it (step 8). A token lasts
       90 days (`cmd/hatchet-admin/cli/token.go:65`): note the date and mint a new one before then.
       Each mint adds a token named `default` under that tenant's **Settings > API Tokens**, where
       an old one can be revoked. On the local stack a mistyped id printed no token and failed
       with `violates foreign key constraint`; if the output on dev is anything but a token, check
       the id.
    6. Give the project its tenant name and id, and tell it the token is in its secret store. It
       sets the variables in `docs/operations/first-consumer.md` section 8 and keeps its own
       namespace.
    7. Confirm: once the project's worker has started with that token, select the new tenant in
       the switcher and open **Workers**. The worker is listed, its name starting with the
       project's namespace. Select the boot tenant: the worker is not listed there. The CTO reports
       only "it worked" or "it did not".
    8. What is per tenant and what is engine-wide:

       | Per tenant | Engine-wide, the same for every tenant |
       |---|---|
       | worker tokens, workers, workflows and runs, the dashboard view, members, alert switches (failed runs, expiring tokens) | retention (`SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD`, *Retention* below) |
       | the project's namespace, which only separates processes inside one tenant | limits: the engine writes default limits for the new tenant (`create.go:83`) but enforces none, because `SERVER_ENFORCE_LIMITS` is unset |
       | | user accounts, signup and the company-domain restriction, tenant creation (`SERVER_ALLOW_CREATE_TENANT`), the Slack app for alerts |
       | | the machine, the database cluster and RabbitMQ: one project's load slows every tenant |

    9. A tenant cannot be removed at v0.107.0: no dashboard page or API call deletes one (the API
       spec's tenant paths delete only invites, members and alert email groups,
       `api-contracts/openapi/paths/tenant/tenant.yaml`). A tenant made by mistake stays; rename it
       under **Settings > General** and revoke its tokens.
    10. Rehearse on the local stack first (same image tag). Run `pnpm hatchet:up`, sign in at
        `http://localhost:8888` with the account in the comment at the top of
        `infra/hatchet/compose.yaml`, and do sub-steps 3 and 4 with the name `rehearsal-<date>`
        (for the API block, set `ENGINE=http://localhost:8888` and that account's email). Then:

        ```bash
        export HATCHET_CLIENT_TOKEN="$(KYU_HATCHET_TENANT_ID=<id> bash infra/hatchet/token.sh)"
        export HATCHET_CLIENT_TLS_STRATEGY=none
        ```

        Start any Kyu worker in that shell (the shop example's `pnpm worker`, see its README "Run
        it locally", or the worker in `first-consumer.md` section 7) and do sub-step 7. Local
        tenants cannot be removed either, and `pnpm hatchet:down` keeps them.

    Rehearsed on the local stack on 2026-10-02 (issue #15): the seeded admin created one tenant
    from the dashboard and one with the API block; each came back with a new id and the admin as
    its Owner. A token minted with `KYU_HATCHET_TENANT_ID=<id> bash infra/hatchet/token.sh`
    registered an SDK worker that the API listed under the new tenant and not under the boot
    tenant, and the same token got 403 reading the boot tenant's workers. A worker token got 403
    creating a tenant, a reused slug got 400, and a made-up id failed the mint with the foreign
    key error. The rehearsal tenants stay on that stack. Not yet done on the dev engine; the CTO
    adds a dated line here when it is.

## Deployment values are secrets

`fly.toml` carries no app name and four engine settings live in Fly secrets instead, so the file can
be public: `SERVER_URL`, `SERVER_AUTH_COOKIE_DOMAIN`, `SERVER_GRPC_BROADCAST_ADDRESS` and
`SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS`. Do this once, before deploying a `fly.toml` that no longer
holds them:

1. Run `bash infra/hatchet/fly/secrets.sh` to print the commands.
2. Stage the four new secrets with today's values from the password manager.
3. `fly secrets list -a <engine-app>` shows all eight names.
4. Deploy (*First deploy* step 6).

Staging first is safe on a live engine: Fly gives a secret priority over an `[env]` value of the
same name. The shop harness app's secrets are in the shop example's `docs/harness-on-fly.md`.
Every `fly` command passes `-a`, because `fly.toml` no longer names the app.

## Retention

The engine keeps run and event history in daily partitions and drops a whole day once it is
older than `SERVER_LIMITS_DEFAULT_TENANT_RETENTION_PERIOD`. That covers runs, task events, events,
logs and payloads, and applies to every tenant on the engine (hatchet v0.107.0). It is an env var
in `fly.toml`, not a dashboard or API setting. The per-tenant "data retention period" the engine
stores is used only for old-worker cleanup, which is off. The value is a Go duration.

- dev: `168h` (7 days), set in `fly.toml`, live from the deploy after 2026-09-27 (issue #224). A
  partition is dropped only once the whole UTC day it holds is older than the period (strict
  `<`), so with the first partition dated 2026-09-27 UTC the first drop, and its log line, comes
  on 2026-10-05 UTC, when `fly logs -a <engine-app>` shows `removing partitions before …
  using retention period of 168h0m0s`.
- production: `720h` (30 days). This is also the engine's default, but set it explicitly in that
  environment's `fly.toml`.
- The engine refuses to boot on a value it cannot parse, so a healthy `/api/ready` after the
  deploy means the value was accepted.
- `SERVER_LIMITS_CORE_PARTITION_RETENTION` and `SERVER_LIMITS_OLAP_PARTITION_RETENTION` override
  this value for the core and OLAP tables separately when set; both must stay unset so one value
  governs everything.

Failure alerts: the engine has its own Slack alerting for failed runs, worked out from the source
(issue #224), but turning it on needs a company Slack app and two CTO secrets. That decision and
the setup steps are deferred to a later PR.

## Upgrade

1. Take a snapshot: `fly mpg backup list <engine-cluster-id>` and, if the platform does not do
   this automatically, trigger one first with `fly mpg backup create <engine-cluster-id>`.
2. Bump the image tag in `infra/hatchet/fly/fly.toml` and `infra/hatchet/compose.yaml` together
   — they must always name the same tag.
3. Deploy dev: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`
4. Soak for a day: watch the dashboard, worker logs, and `/api/ready` for anything unusual.
5. Only then promote the same tag to any later environment.
6. Check every entry under *Known engine defects* against the new release before promoting it;
   drop an entry only once its proof page's queries come back empty after a load run.

### Known engine defects

**v0.107.0 — the run list keeps an ended run as queued or running.** 294 runs on the local engine
and 18 on Fly dev (#165, #170). Not reproducible from a fresh namespace; it follows the engine
stopping between writing its own state and the list's copy. The SDK's run readers read the
engine's run detail for such runs (README). Evidence, queries and what to raise upstream:
`docs/proofs/2026-09-23-engine-run-list-stale-rows.md`.

## Resizing the engine machine

1. `fly machine update <id> --vm-size performance-2x` can be refused with "insufficient memory
   available to fulfill request on the current host"; the update reverts without a restart.
2. Fork and clone (CTO-run), in this order: stop the old machine; fork its config volume —
   `fly volumes fork <old-engine-volume-id> -a <engine-app> -n kyu_hatchet_config_2x --vm-size performance-2x`;
   clone the machine onto the forked volume —
   `fly machine clone <old-engine-machine-id> -a <engine-app> --attach-volume <new vol id>:/config --vm-size performance-2x`;
   then update `fly.toml`'s `source` and `size`. The fork copies `/config`, so existing worker
   tokens keep working — the #173 report run registered with a token minted before the clone.
3. **Never run two engine machines against one cluster.** During about 70 seconds of overlap on
   2026-09-23 the Starter cluster refused connections ("remaining connection slots are
   reserved…", "too many clients"); one engine machine hit the same error under `tenant-load`
   load later, alone. Stop the old machine first.
4. Roll back (CTO; no longer possible — `<old-engine-machine-id>` was destroyed on 2026-09-23, issue #176):
   `fly machine stop <engine-machine-id> -a <engine-app>`, wait for `stopped` in
   `fly machine list`, `fly machine start <old-engine-machine-id> -a <engine-app>`, revert `fly.toml`'s
   `source`/`size`.
5. Do not `fly deploy` the engine while both machines exist: flyctl replaces a machine whose
   volume name differs from `fly.toml` (`internal/command/deploy/machines_launchinput.go`).
   Destroying the rollback machine and its volume is the CTO's call. Once destroyed, this rollback
   path is gone — see "Queue on RabbitMQ" below, which destroys `<old-engine-machine-id>` before switching
   the engine's queue.

## Backup and restore rehearsal

1. List available backups: `fly mpg backup list <engine-cluster-id>`
2. Restore into a **new** cluster — never onto the live one:
   `fly mpg restore <engine-cluster-id> --backup-id <backup-id> -n <destination-name>`, choosing a
   destination cluster name that does not exist yet.
3. Point a scratch app's `DATABASE_URL` at the restored cluster and confirm the engine starts
   and the dashboard shows the expected run history.
4. Record the date and what was restored on this page, in the section below.

**Restore log**

**2026-09-23 NZ time (issue #162 PR B; the backup id and its UTC timestamps below read 2026-09-22).**
Source backup `20260922-121422F_20260922-130302I` (incremental,
completed `2026-09-22T13:03:02Z`), restored into a new throwaway cluster
`<engine-db>-restoretest` (id `<restore-test-cluster-id>`), region `syd`, plan Basic — same shape as
the source. `fly mpg restore` returned immediately; the cluster read `creating` in `fly mpg list`
until `ready` about 3.5 minutes later (started `13:28:45Z`, confirmed `ready` at the `13:32:18Z`
poll; polling was on a 15-second interval, so the true finish time is somewhere in that window).
The source cluster `<engine-db>` was confirmed untouched and still `ready` throughout.

**2026-09-23 (issue #173):** the CTO destroyed `<engine-db>-restoretest`
(`<restore-test-cluster-id>`). The three-number data check was skipped. The restore is proven to complete,
not proven to hold readable data.

## When the engine is unhealthy

Work through these in order:

1. `fly status -a <engine-app>` — is a machine running at all, and how long has it been up?
   The engine generates its encryption keysets and cookie secrets into `/config/server.yaml` on
   first boot and reuses them from there while the `kyu_hatchet_config_2x` volume stays attached, so
   a restart of the same machine keeps previously minted worker tokens working. A machine
   replacement with that volume attached keeps working the same way; a machine replacement with
   the volume missing or in the wrong region does not, because the engine generates a fresh set
   of keys with nothing there to read back. The alternative is setting the
   `SERVER_ENCRYPTION_MASTER_KEYSET` / `SERVER_ENCRYPTION_JWT_PRIVATE_KEYSET` /
   `SERVER_ENCRYPTION_JWT_PUBLIC_KEYSET` / `SERVER_AUTH_COOKIE_SECRETS` secrets so the keys live
   in the environment instead of the volume — see `secrets.sh`'s optional block. They are not set
   on dev.
2. `fly logs -a <engine-app>` — look for a crash loop, a database connection error, or a
   migration failure at start.
3. `curl -s https://<engine-app>.fly.dev/api/ready` — is the API answering at all?

   `/api/ready` answering 200 does not mean the REST API is ready. After the 2026-09-23 restart,
   run reads answered 500 for at least ~3 minutes; a check 8 minutes after the restart passed.
   Wait 10 minutes, or run a smoke-size harness run, before a report-size run.
4. `fly mpg status <engine-cluster-id>` — is the database cluster itself healthy? This prints
   connection details, so the CTO runs it, not an agent.
5. Check the volume: has the machine been replaced? A replacement with no volume attached, or a
   volume in the wrong region, means `/config` starts empty and the engine generates a fresh
   keyset — confirmed on first deploy (issue #162 PR B): `Generating encryption keys for Hatchet
   server` / `Generating config files ./config` in `fly logs` on first boot, matching the local
   container's own behaviour. That same session redeployed the same machine (same machine id)
   three times to fix the gRPC port config, and each redeploy rebooted the container (`fly logs`
   shows `Sending signal SIGINT to main child process`, `Restarting system`, then Firecracker
   booting again) — and each time, `fly logs` printed the same "Generating encryption keys" /
   "Generating config files" lines again, even though `--overwrite=false` should mean it reuses
   what is already on the volume. **Confirmed 2026-09-23 (issue #173):** a worker token minted
   before a machine restart still works after it. The CTO restarted `<old-engine-machine-id>` at
   06:53:50Z; a smoke-size harness run with the old token passed at 07:02Z
   (`docs/proofs/data/report-173-smoke-after-restart.json`). The same token also worked on the
   cloned machine with the forked volume. The "Generating encryption keys" and "Generating config
   files" lines were printed again on that restart and on the clone, so they are printed every
   boot and do not mean new keys were written.
6. If nothing above explains it, re-read the first-deploy steps for anything skipped or done out
   of order, then ask the CTO to check the secrets are all set.

## Queue on RabbitMQ

Hatchet's internal message queue can run on Postgres or on RabbitMQ. The engine ran on Postgres
from the first deploy until 2026-09-23; every failed run on Fly failed inside that Postgres-backed
queue (issue #173). Hatchet's documented default and production queue is RabbitMQ, and the
hatchet-lite image we run supports it. Issue #176 adds a private RabbitMQ app, `<rabbitmq-app>`,
so the CTO can run the shop harness once with the queue on RabbitMQ, everything else unchanged,
before deciding which queue to keep. The switch was made on 2026-09-23 and the run passed both load
scenarios (proof page, issue #176). On 2026-09-25 RabbitMQ was kept (see "After the run" below).

hatchet-lite (`cmd/hatchet-lite/main.go` at v0.107.0) forces the Postgres queue only when none of
the four queue variables is set in the environment — `SERVER_MSGQUEUE_KIND`,
`SERVER_MSGQUEUE_RABBITMQ_URL`, and the legacy `SERVER_TASKQUEUE_KIND` /
`SERVER_TASKQUEUE_RABBITMQ_URL` — that is why the engine has run Postgres with no queue setting at
all. `<rabbitmq-app>` has no public
address and no management UI: everything outside the private network reaches it only through
`fly machine exec`. The local Docker stack (`infra/hatchet/compose.yaml`) stays on the Postgres
queue; nothing here changes it.

**First deploy of RabbitMQ** (an engineer does steps 1, 2, 4 and 5; the CTO does step 3):

1. Create the app: `fly apps create <rabbitmq-app> -o <fly-org>`
2. Create the data volume, in `syd`, before any deploy: `fly volumes create kyu_rabbitmq_data -r syd -s 3 -a <rabbitmq-app> --vm-size performance-1x`
   — the `--vm-size` flag places the volume on a host that can fit a `performance-1x` machine;
   "Resizing the engine machine" above hit "insufficient memory available to fulfill request on
   the current host" from a volume placed without one.
3. **Before step 4**: the CTO runs `bash infra/hatchet/fly/rabbitmq/secrets.sh` and the two
   `fly secrets set --stage` commands it prints, filling in `RABBITMQ_DEFAULT_USER` and
   `RABBITMQ_DEFAULT_PASS` from 1Password. RabbitMQ reads both only on its first boot with an
   empty data volume; if step 4 runs first, RabbitMQ creates a `guest` account that this image
   lets connect from other machines on the private network. If that happens, destroy the machine
   and volume and restart at step 2.
4. Deploy: `fly deploy -c infra/hatchet/fly/rabbitmq/fly.toml -a <rabbitmq-app> --ha=false`
5. Check: `fly checks list -a <rabbitmq-app>` shows the `amqp` check passing; `fly logs -a <rabbitmq-app> --no-tail`
   shows `started TCP listener on [::]:5672` and `Server startup complete` (the `[::]` matters —
   Fly's private network, 6PN, is IPv6 only); `fly ips list -a <rabbitmq-app>` is empty (no
   public address). The CTO runs `fly machine exec <id> 'rabbitmqctl -n rabbit@localhost -q list_users' -a <rabbitmq-app>`
   (prints the user name, so only the CTO runs it) and confirms it lists exactly one user and no
   `guest`.

**Switching the engine to RabbitMQ** (the CTO sets the secret and destroys the rollback machine;
an engineer or agent can do the rest): confirm the RabbitMQ check above is passing first —
otherwise the engine exits at boot with `could not init rabbitmq` and restarts in a loop. Confirm
no harness run is in progress: any run already queued stays on the Postgres queue through a
switch. The CTO destroys the stopped rollback machine first —
`fly machine destroy <old-engine-machine-id> -a <engine-app>` — because a deploy replaces a machine
whose volume name differs from `fly.toml`, and with the rollback machine still present that would
start a second engine against the same cluster (see "Resizing the engine machine" above for why
two engine machines against one cluster is unsafe); destroying its volume `<old-engine-volume-id>`
is the CTO's call. The CTO fills in only the `SERVER_MSGQUEUE_RABBITMQ_URL` line from
`infra/hatchet/fly/secrets.sh` (built from the two RabbitMQ values:
`amqp://<user>:<pass>@<rabbitmq-app>.internal:5672/`). Then
`fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>` updates machine `<engine-machine-id>` in
place on the same volume, so `/config` and every minted worker token survive. Wait 10 minutes, or
run a smoke-size harness run, before a report-size run — the same rule as any other engine
restart.

**What connected looks like:** with `SERVER_MSGQUEUE_KIND = 'rabbitmq'` the engine dials RabbitMQ
before it starts serving and exits if it cannot (`pkg/config/loader/loader.go`), so `/api/ready`
answering 200 already means the engine is connected to RabbitMQ. Engine logs since the deploy
have no `cannot (re)dial` line (the URL is printed with the password masked) and no
`Creating new Postgres message queue` line. The CTO can also run
`fly machine exec <id> 'rabbitmqctl -n rabbit@localhost -q list_connections peer_host state' -a <rabbitmq-app>`
and see connections from the engine's private address (`fly machine list -a <engine-app>`),
all `running`; `list_queues name messages consumers` lists Hatchet's queues with consumers
attached. During and after a run, watch `fly logs -a <rabbitmq-app>` for any `alarm` line
(memory or disk) — that means RabbitMQ blocked the engine's publishes, and the harness numbers
from that window are not clean; the proof page must say so. Note that quickstart rewrites
`/config/server.yaml` with the RabbitMQ URL on every boot, the same way it already holds
`DATABASE_URL`.

**Observed on 2026-09-23 (issue #176):** RabbitMQ logged `started TCP listener on [::]:5672` and
`Server startup complete; 4 plugins started.`, its `amqp` check passed and `fly ips list` was
empty. After `fly deploy` of the engine at 12:14:31Z, `/api/ready` answered 200, the engine's boot
log had no `Creating new Postgres message queue` line, and RabbitMQ's log showed 14 `accepting
AMQP connection` lines, each followed by an `authenticated and granted access` line, all from one
private address, 14 seconds later. RabbitMQ logged nothing more through the end of the harness
run: no `alarm` line. Read RabbitMQ's connection lines yourself rather than pasting them: they
print the user name.

**Switching back to the Postgres queue:** for an emergency only — staying on the Postgres queue in
a deployed environment needs a new ADR (see "After the run" below). A PR that sets
`SERVER_MSGQUEUE_KIND = 'postgres'` in `infra/hatchet/fly/fly.toml`; confirm no harness run is in
progress; `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`. The
`SERVER_MSGQUEUE_RABBITMQ_URL` secret can stay set — hatchet-lite ignores it once the kind is
`postgres`. Check `list_connections` on `<rabbitmq-app>` shows nothing from the engine anymore.

**After the run:** decided on 2026-09-25: the engine's queue stays on RabbitMQ in every deployed
environment, see
[`20260925-engine-queue-runs-on-rabbitmq.md`](../architecture/adr/20260925-engine-queue-runs-on-rabbitmq.md).
`<rabbitmq-app>` and the engine's `SERVER_MSGQUEUE_RABBITMQ_URL` secret stay. The switch-back
and teardown steps this paragraph listed before that date are not needed.

## Running the shop harness in-region

Moved with the shop to [`kyuworks/shop-example`](https://github.com/kyuworks/shop-example/blob/main/docs/harness-on-fly.md). The engine-side rules on this page (both clusters on Launch before a report-size run) still apply.
