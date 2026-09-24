# Running the Kyu engine on Fly

This page covers the deployed Hatchet engine for the Kyu message bus: `infra/hatchet/fly/`
(issue #162). It does not cover the local stack — see `infra/hatchet/compose.yaml` and
`infra/hatchet/token.sh` for that.

Today there is one environment: dev, org `<fly-org>`, region `syd`. What exists on Fly for it
as of 2026-09-25:

- the engine app `<engine-app>`, machine `<engine-machine-id>` (`performance-2x`, 4 GB), config
  volume `kyu_hatchet_config_2x` (`<engine-config-volume-id>`), queue on RabbitMQ;
- the RabbitMQ app `<rabbitmq-app>`, machine `<rabbitmq-machine-id>` (`performance-1x`), data volume
  `<rabbitmq-volume-id>`, no public IP address;
- the engine's database cluster `<engine-db>` (cluster id `<engine-cluster-id>`), on Basic.

The shop harness app `<shop-harness-app>` and its cluster `<shop-harness-db>`
(`<shop-cluster-id>`) were destroyed on 2026-09-25; "Running the shop harness in-region" below says
how to recreate them.

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

## First deploy

1. Allocate a dedicated IPv4: `fly ips allocate-v4 -a <engine-app>` (about US$2/month). Fly's
   shared IPv4 only serves ports 80 and 443; the engine's gRPC service listens on 7077, and without
   a dedicated IPv4 no worker can reach it. Confirmed needed on first deploy (issue #162 PR B):
   `fly ips list -a <engine-app>` must show a `v4` row of type `public`, not `shared`.
2. Create the app: `fly apps create <engine-app> -o <fly-org>`
3. Create the managed Postgres cluster: `fly mpg create -o <fly-org> -n <engine-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10`
4. Create the config volume, **before** the secrets step and before the first deploy —
   `fly deploy` does not create the volume `fly.toml` mounts, so it must exist first:
   `fly volumes create kyu_hatchet_config -r syd -a <engine-app>` (size per the plan, or 1 GB
   if none is set). It must be created in `syd`; a volume in another region cannot attach to a
   machine in `syd`. This has to come before the engine ever starts: the engine generates its own
   encryption keysets and cookie secrets into `/config` on first boot, so with no volume attached
   those keys land on the machine's ephemeral disk and every worker token minted against them
   dies with that machine.
5. The CTO opens the cluster's page in the Fly dashboard, copies the **direct** connection
   string (not the pooler — Hatchet needs a session-mode connection for LISTEN/NOTIFY,
   prepared statements and advisory locks, all of which a transaction pooler breaks), then runs
   `infra/hatchet/fly/secrets.sh` to see every command, fills in each placeholder — including
   `DATABASE_URL` with that string — from 1Password, and runs the `fly secrets set --stage ...`
   commands it prints. There is no `fly mpg attach` step here. Four secrets are required
   (`DATABASE_URL`, `SERVER_AUTH_ADMIN_EMAIL`, `SERVER_AUTH_ADMIN_PASSWORD`, and
   `SERVER_MSGQUEUE_RABBITMQ_URL` while the queue is RabbitMQ — see *Queue on RabbitMQ*); the
   script's `Optional overrides` block covers the four keyset and cookie secrets, which the engine
   otherwise generates itself into the volume created in step 4. Confirmed on first deploy: the
   direct connection string needed no `sslmode` parameter — the schema migration ran clean with no
   SSL error in the logs.
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
   override. If a future re-seed ever produces a different id, read the real one off the
   dashboard's tenant settings and pass it with `--tenant-id`.
10. Register one worker against it (see `examples/shop/README.md`, "Against the deployed dev
    engine") and confirm it shows up in the dashboard.
11. **Before leaving the dashboard reachable at `https://<engine-app>.fly.dev`, confirm the
    admin login actually uses the credentials the CTO set, not `hatchet-lite`'s own default.** The
    CTO signs in with the `SERVER_AUTH_ADMIN_EMAIL` / `SERVER_AUTH_ADMIN_PASSWORD` values from step
    5 and reports only "it worked" or "it did not"; if it did not, they try the documented
    `hatchet-lite` default (`admin@example.com`) — if that signs in instead, the account must be
    changed through the dashboard immediately and this page updated with what was found. **This
    step was not performed in the issue #162 PR B session** (it needs an interactive CTO login) and
    is the one open item from that deploy: until it is done, treat the dashboard as carrying an
    unconfirmed admin account.

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
   `fly mpg restore <engine-cluster-id> --backup-id <id> -n <destination-name>`, choosing a
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
   first boot and reuses them from there while the `kyu_hatchet_config` volume stays attached, so
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

This runs the shop's failure harness (`examples/shop/src/__tests__/harness/`) from inside `syd`,
beside `<engine-app>`, instead of from a laptop (issue #166, following #165 option 1). It uses a
second, separate app — `<shop-harness-app>` — plus its own database cluster
(`<shop-harness-db>`, Postgres 17, 10 GB, `syd`). It does not change `<engine-app>` or
`<engine-db>` at all.

**Destroyed on 2026-09-25.** The app and its cluster (cluster id `<shop-cluster-id>`; Basic from
2026-09-24 after issue #198, before that Basic, then Starter, then Launch on 2026-09-23) were
destroyed on the CTO's instruction; see "Destroying the cluster" below. Neither exists now. Machine
ids and the cluster id below are from before that date. To run the harness again, recreate both
with the steps that follow, in order: "One-time setup" (the app, a new cluster and its
`kyu_shop_inregion` database), then "The CTO's steps, in order" (the two secrets through
`infra/shop-harness/fly/secrets.sh`, from the new cluster's direct connection string and a newly
minted engine token), then "Running it". A new cluster gets a new cluster id: use it wherever this
section or the text `infra/shop-harness/fly/secrets.sh` prints says `<shop-cluster-id>`. Before a
report-size run, move the new cluster to Launch (see
**Before a report-size harness run** at the top of this page).

**Who does what:** an engineer (or an agent, for the parts that touch no secret) creates the app,
the cluster, and the image, and drives every deploy, start, collect and stop below. The CTO sets
the two secrets on the harness app and never anything on `<engine-app>`. Neither role reads a
Fly connection string or a token back once set — the checks below use names-only listings.

### One-time setup

1. Create the app: `fly apps create <shop-harness-app> -o <fly-org>`
2. Create a second Basic managed Postgres cluster — **never** the engine's own cluster
   (`<engine-db>`, `<engine-cluster-id>`) and never `<engine-db>-restoretest`
   (destroyed 2026-09-23). Redirect stdout to `/dev/null`; it carries one-time
   credentials:
   `fly mpg create -o <fly-org> -n <shop-harness-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10 >/dev/null`
   (the command line cannot change a cluster's plan; before a report-size run, move the cluster to
   Launch in the Fly dashboard, see the note at the top of this page).
3. Confirm it reached `ready` with names only: `fly mpg list -o <fly-org>`.
4. Create the database inside the cluster: `fly mpg databases create <shop-cluster-id> -n kyu_shop_inregion`
   — the managed Postgres user lacks `CREATEDB`, so `migrate` cannot create it itself.
5. Validate the config: `fly config validate -c infra/shop-harness/fly/fly.toml -a <shop-harness-app> --strict`
6. Validate the image on Fly's remote builder, with no machine created and no secret needed:
   `fly deploy . -c infra/shop-harness/fly/fly.toml --dockerfile infra/shop-harness/fly/Dockerfile --ignorefile infra/shop-harness/fly/harness.dockerignore --build-arg KYU_HARNESS_COMMIT_SHA="$(git rev-parse HEAD)" --build-only -a <shop-harness-app>`

**The CTO's steps, in order** (needed once, before the first real run):

1. In the Fly dashboard, open Managed Postgres → `<shop-harness-db>`. Copy the **direct**
   connection string (not the pooler — the relay and migrations need session-mode semantics, the
   same reason step 5 of the first-deploy section above gives). Change the database name at the
   end of its path to `kyu_shop_inregion`. Store the string in 1Password.
2. Run `bash infra/shop-harness/fly/secrets.sh`, fill in its `KYU_SHOP_DATABASE_URL` line from
   step 1, and run it.
3. Run `fly ssh issue` for the org, only if that has not already been done (it was, for #162).
4. Run the token line `secrets.sh` prints exactly as written, so the token never reaches the
   screen or shell history as an argument:
   `printf 'HATCHET_CLIENT_TOKEN=%s\n' "$(bash infra/hatchet/fly/token.sh -a <engine-app>)" | fly secrets import --stage -a <shop-harness-app>`

   `hatchet-admin token create` with no expiry flag mints a token that lasts 90 days, measured as
   `exp` minus `iat` on v0.107.0 (the admin tool's own default is 2160h — the same 90 days). Re-mint
   before then. `invalid auth token` in the harness logs, seen only at report size and not at smoke
   size (#165), is an open hypothesis — engine-side token validation under load — not a confirmed
   cause: a smoke-size run with zero such lines shows only that the token was accepted at smoke
   size that day, not why the report-size lines appeared. Whether to re-mint before the 90 days are
   up is the CTO's decision.
5. Reply "done" on the tracking issue, with no values in the reply.

Whether the two secrets are staged can be checked with names only, never by reading a value:

```bash
fly secrets list -a <shop-harness-app> --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(x=>x.name ?? x.Name).sort().join("\n")))'
```

This should list exactly `HATCHET_CLIENT_TOKEN` and `KYU_SHOP_DATABASE_URL`. Whether the database
string actually names `kyu_shop_inregion` and works cannot be checked without reading it — the
first run's `migrate-done` log line is the check; a wrong name fails loudly with `refusing to
create database "<name>"`, which names the database, not the credentials.

### Running it

**A `fly deploy` only starts a run the first time, when it creates the machine.** On every deploy
after that, the machine already exists and is `stopped` (restart policy `never`); a deploy to an
existing machine only updates its config (including applying any newly staged secret) and leaves
it `stopped`. **`fly machine start <id> -a <shop-harness-app>` is the
step that actually executes `run.sh` again.** There is no separate "create" step once the app and
cluster above exist.

1. From a clean tree (`git diff --quiet && git diff --cached --quiet`), deploy:
   `fly deploy . -c infra/shop-harness/fly/fly.toml --dockerfile infra/shop-harness/fly/Dockerfile --ignorefile infra/shop-harness/fly/harness.dockerignore --build-arg KYU_HARNESS_COMMIT_SHA="$(git rev-parse HEAD)" --ha=false -a <shop-harness-app>`
   — this creates the machine and starts it only if the app has none yet; otherwise it updates the
   existing (stopped) machine's config and image without running it.
2. Start the run: `fly machine start <id> -a <shop-harness-app>`.
3. Watch `fly logs -a <shop-harness-app>` for the harness's own event lines: `preflight-ok`,
   `migrate-done` (including the database name `migrateLogFields()` logs — see the pitfall below),
   one `report-written` per scenario, then `harness-done`. Do not paste engine or harness logs into
   a pull request or a chat message beyond the event lines named here.
4. Copy each scenario's report back, verified by its sha256, while the machine holds open
   (`KYU_HARNESS_HOLD_SECONDS` in `fly.toml`):
   `bash infra/shop-harness/fly/collect.sh -a <shop-harness-app> -m <machine-id> -s tenant-load -o docs/proofs/data/report-166-tenant-load.json`
   (and the same for `outbox-backlog`). The `-o` path must be absolute or repository-relative from
   the repo root — `#164`'s laptop-to-Fly run lost a report to a path resolved from the wrong
   working directory.

   Collect before you stop. Run `collect.sh` on its own and wait for `collected`; never chain
   `fly machine stop` after it in one command. On 2026-09-23 a 6.7 MB report was lost that way.
   `collect.sh` reads a report in 1 MB parts, because one exec answer has a size limit — on
   2026-09-23 that read failed: `Error: could not exec command on machine`.
5. Stop the machine once both reports are collected: `fly machine stop <id> -a <shop-harness-app>`
6. Verify it actually stopped, names and states only:
   `fly machine list -a <shop-harness-app> --json` and `fly status -a <shop-harness-app>`.

**Pitfall: a `KYU_SHOP_DATABASE_URL` naming the wrong cluster fails the same way as a missing
grant.** `migrate`'s `start`/`failed` log lines print the database name only
(`{"process":"migrate","event":"start","database":"<name>"}`), never the connection string. If
that name is right but migrate still fails with `permission denied to create database`, the
database name is not the problem — check that the string's **host** is the shop cluster's
(`<shop-harness-db>`, id `<shop-cluster-id>`), not the engine's (`<engine-db>`, id
`<engine-cluster-id>`), which has no `kyu_shop_inregion` database at all. An unchanged secret digest
in `fly secrets list` after a re-stage means the value was not actually changed.

If nobody collects in time, the machine exits on its own after `KYU_HARNESS_HOLD_SECONDS` and
reads `stopped` — nothing is left running either way.

**To run again** (the app and cluster already exist): `fly machine start <id> -a <shop-harness-app>`
runs `CMD` once more, because the restart policy is `never`. To run one scenario only:
`fly machine update <id> -e KYU_HARNESS_SCENARIOS=outbox-backlog --skip-start -a <shop-harness-app>`,
then start it.

### Network path and its fallback

The standing config points the harness at the engine's internal 6PN address, plaintext
(`<engine-app>.internal`, `HATCHET_CLIENT_TLS_STRATEGY = 'none'`) — how a same-org consumer
reaches the engine in production. If that path does not answer, `run.sh`'s preflight
(`GET $HATCHET_CLIENT_API_URL/api/ready`) fails within seconds and the run never starts a
scenario. The fallback is the public edge, the same path the laptop-to-Fly run (#164) used:

```bash
fly machine update <id> -a <shop-harness-app> --skip-start \
  -e HATCHET_CLIENT_HOST_PORT=<engine-app>.fly.dev:7077 \
  -e HATCHET_CLIENT_API_URL=https://<engine-app>.fly.dev \
  -e HATCHET_CLIENT_TLS_STRATEGY=tls \
  -e HATCHET_CLIENT_TLS_SERVER_NAME=<engine-app>.fly.dev
fly machine start <id> -a <shop-harness-app>
```

If a run used this fallback, the proof page says so and labels that column "in-region via edge".
If the fallback becomes the standing path, also edit `fly.toml`'s `[env]` block, or the next
`fly deploy` reverts it.

### Cancelling a harness namespace

A scenario run can leave runs queued or running on the engine under its own namespace after the
harness exits — a durable run whose worker stopped mid-retry is invisible to a single check (#165).
`fly machine start <id>` cannot be used to clean these up: starting `<shop-harness-machine-id>` runs the image's
own `CMD`, `bash infra/shop-harness/fly/run.sh`, which is the full report-size scenario suite, not a
one-off command.

Instead, build and push an image without touching any machine:

```bash
fly deploy . -c infra/shop-harness/fly/fly.toml --dockerfile infra/shop-harness/fly/Dockerfile \
  --ignorefile infra/shop-harness/fly/harness.dockerignore \
  --build-arg KYU_HARNESS_COMMIT_SHA="$(git rev-parse HEAD)" \
  --build-only --push --image-label <image-label> -a <shop-harness-app>
```

Then run the cancel CLI as a throwaway machine that removes itself, naming one namespace to cancel:

```bash
fly machine run -a <shop-harness-app> -r syd --vm-size shared-cpu-1x --rm \
  -e HATCHET_CLIENT_HOST_PORT=<engine-app>.internal:7077 \
  -e HATCHET_CLIENT_API_URL=http://<engine-app>.internal:8888 \
  -e HATCHET_CLIENT_TLS_STRATEGY=none \
  registry.fly.io/<shop-harness-app>:<image-label> \
  node examples/shop/dist/__tests__/harness/cancelNamespaceCli.js <namespace>
```

**One namespace per `fly machine run`.** On 2026-09-24 (issue #198) two namespaces given this way
reached the CLI as one argument, `"<first> <second> "`, and it exited 1 with `is not a harness
namespace`. For more than one, loop:

```bash
for ns in <namespace> <namespace>; do
  fly machine run -a <shop-harness-app> -r syd --vm-size shared-cpu-1x --rm \
    -e HATCHET_CLIENT_HOST_PORT=<engine-app>.internal:7077 \
    -e HATCHET_CLIENT_API_URL=http://<engine-app>.internal:8888 \
    -e HATCHET_CLIENT_TLS_STRATEGY=none \
    registry.fly.io/<shop-harness-app>:<image-label> \
    node examples/shop/dist/__tests__/harness/cancelNamespaceCli.js "$ns"
done
```

**Finding a run's namespaces.** The harness log does not print them. Each scenario namespace
prefixes the worker and queue names in the engine's log, so search a saved engine log tail:
`grep -oh '<prefix>_[a-z_]*_[0-9a-f]\{6\}_' <engine log> | sort -u`, where `<prefix>` is
`KYU_SHOP_NAMESPACE` without its last underscore (`inregion198` finds
`inregion198_tenant_load_7d76f5_`). A scenario that starts no worker, such as `outbox-backlog`,
does not appear.

Each namespace takes at least 60 seconds to settle, and that settle wait counts toward whatever
scenario duration you are comparing it against — see the proof page's comparison-table note. The
log line `cancel-namespace` gives `found` (runs before cancelling), `acceptedByEngine` (the sum of
what the engine's own cancel call accepted) and `left` (what the engine's list still shows after
cancelling); an exit code of 1 means at least one namespace still holds runs. The machine removes
itself when it exits — confirm with `fly machine list -a <shop-harness-app>`.

**This command only accepts a scenario namespace** (a prefix ending `_<6 hex chars>_`, the shape
`scenarioNamespace` mints) — not a bare project prefix like `shop_`, which the SDK would cancel by
prefix across the whole tenant.

**A namespace can stay above 0 forever.** The engine's REST run list can keep showing a run as
RUNNING or QUEUED after it has actually completed or been cancelled; this command's cancel and
`left` count cannot detect or clear that state, so a namespace that never reaches 0 after repeated
runs is not necessarily still doing anything (issues #165, #170). `left` now leaves out runs the
engine's run detail says completed or failed; what remains is either live or a durable run the
engine stopped tracking — see Known engine defects.

### Destroying the cluster

Done on 2026-09-25, on the CTO's instruction: `fly apps destroy <shop-harness-app>` removed the
app and its machine, and `fly mpg destroy <shop-cluster-id>` destroyed `<shop-harness-db>`.
Confirmed: `fly apps list -o <fly-org>` no longer lists `<shop-harness-app>`, and
`fly mpg list -o <fly-org>` no longer lists `<shop-harness-db>`; both still list the engine
app, `<rabbitmq-app>` and `<engine-db>` respectively.

After a future run, the lane that recreated the cluster may destroy it once the CTO accepts that
run's proof, with no CTO step: `fly mpg destroy <cluster-id>`, then the same `fly mpg list` check.
The app can be destroyed the same way with `fly apps destroy <shop-harness-app>`, or left in
place (its machine stays `stopped` at no cost).
