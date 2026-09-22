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

**2026-09-22 (issue #162 PR B).** Source backup `20260922-121422F_20260922-130302I` (incremental,
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
`fly mpg destroy <engine-db>-restoretest` and confirms with `fly mpg list -o <fly-org>` that
it is gone and `<engine-db>` is untouched. **`<engine-db>-restoretest` is left running
as of this entry** — it was created in this lane but the plan gates destroying it on the CTO's
verification, which this session could not get synchronously. Until it is destroyed it costs the
same as a second Basic-plan cluster.

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
