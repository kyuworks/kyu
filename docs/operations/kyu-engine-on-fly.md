# Running the Kyu engine on Fly

This page covers the deployed Hatchet engine for the Kyu message bus: `infra/hatchet/fly/`
(issue #162). It does not cover the local stack — see `infra/hatchet/compose.yaml` and
`infra/hatchet/token.sh` for that.

Today there is one environment: dev, app `<engine-app>`, org `<fly-org>`, region `syd`,
database cluster `<engine-db>` (cluster id `<engine-cluster-id>`).

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
   commands it prints. There is no `fly mpg attach` step here. Only three secrets are required
   (`DATABASE_URL`, `SERVER_AUTH_ADMIN_EMAIL`, `SERVER_AUTH_ADMIN_PASSWORD`); the script's
   `Optional overrides` block covers the four keyset and cookie secrets, which the engine
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

**What is not yet done, and needs the CTO:** connecting to the restored cluster needs its
connection string, which only the CTO reads (this lane's implementer never sees a Fly connection
string). The CTO still needs to connect with `psql` and report three plain numbers — that `\dt`
lists Hatchet's own tables, the row count of the tenant table, and the count of task rows — after
which the lane (or whoever picks this up next) destroys `<engine-db>-restoretest` with
`fly mpg destroy <restore-test-cluster-id>` (the command takes the cluster id, not the name) and confirms
with `fly mpg list -o <fly-org>` that it is gone and `<engine-db>` is untouched. **This is
open item #165.**

**`<engine-db>-restoretest` is left running as of this entry** — it was created in this lane
but the plan gates destroying it on the CTO's verification, which this session could not get
synchronously. Until it is destroyed it costs the same as a second Basic-plan cluster.

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
   what is already on the volume. Minting a fresh token after each restart kept working, but a
   fresh mint reading current config either way does not test whether a token minted *before* a
   restart still works *after* it — that is the actual claim this runbook makes, and it was not
   tested this session. **Not yet confirmed on this deployment:** that a worker token minted before
   a machine restart still works after it. That needs a CTO-run `fly machine restart` (an agent
   must not run it) followed by a re-check of an already-minted token; while checking, also look at
   whether the "Generating encryption keys" log line means what it says or is printed
   unconditionally regardless of whether it wrote anything.
6. If nothing above explains it, re-read the first-deploy steps for anything skipped or done out
   of order, then ask the CTO to check the secrets are all set.

## Running the shop harness in-region

This runs the shop's failure harness (`examples/shop/src/__tests__/harness/`) from inside `syd`,
beside `<engine-app>`, instead of from a laptop (issue #166, following #165 option 1). It is a
second, separate app — `<shop-harness-app>` — plus its own database cluster
(`<shop-harness-db>`, cluster id `<shop-cluster-id>`, Basic, Postgres 17, 10 GB, `syd`). It
does not change `<engine-app>` or `<engine-db>` at all.

**Who does what:** an engineer (or an agent, for the parts that touch no secret) creates the app,
the cluster, and the image, and drives every deploy, start, collect and stop below. The CTO sets
the two secrets on the harness app and never anything on `<engine-app>`. Neither role reads a
Fly connection string or a token back once set — the checks below use names-only listings.

### One-time setup

1. Create the app: `fly apps create <shop-harness-app> -o <fly-org>`
2. Create a second Basic managed Postgres cluster — **never** the engine's own cluster
   (`<engine-db>`, `<engine-cluster-id>`) and never `<engine-db>-restoretest`
   (waiting to be destroyed under #165). Redirect stdout to `/dev/null`; it carries one-time
   credentials:
   `fly mpg create -o <fly-org> -n <shop-harness-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10 >/dev/null`
3. Confirm it reached `ready` with names only: `fly mpg list -o <fly-org>`.
4. Validate the config: `fly config validate -c infra/shop-harness/fly/fly.toml -a <shop-harness-app> --strict`
5. Validate the image on Fly's remote builder, with no machine created and no secret needed:
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
it `stopped` — confirmed three times in the #166 session, including once where a deploy alone was
mistaken for a run and produced nothing. **`fly machine start <id> -a <shop-harness-app>` is the
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

### Destroying the cluster

This lane created `<shop-harness-db>`, so this lane may destroy it once the CTO accepts the
in-region proof — no CTO step is needed for that part: `fly mpg destroy <cluster-id>`, then
confirm with `fly mpg list -o <fly-org>` that it is gone and every other cluster is unaffected.
The app `<shop-harness-app>` can be left in place (its machine stays `stopped` at no cost) for
the next run, or destroyed the same way with `fly apps destroy <shop-harness-app>`.
