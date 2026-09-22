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

1. Create the app: `fly apps create <engine-app> -o <fly-org>`
2. Create the managed Postgres cluster: `fly mpg create -o <fly-org> -n <engine-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10`
3. Create the config volume, **before** the secrets step and before the first deploy —
   `fly deploy` does not create the volume `fly.toml` mounts, so it must exist first:
   `fly volumes create kyu_hatchet_config -r syd -a <engine-app>` (size per the plan, or 1 GB
   if none is set). It must be created in `syd`; a volume in another region cannot attach to a
   machine in `syd`. This has to come before the engine ever starts: the engine generates its own
   encryption keysets and cookie secrets into `/config` on first boot, so with no volume attached
   those keys land on the machine's ephemeral disk and every worker token minted against them
   dies with that machine.
4. The CTO opens the cluster's page in the Fly dashboard, copies the **direct** connection
   string (not the pooler — Hatchet needs a session-mode connection for LISTEN/NOTIFY,
   prepared statements and advisory locks, all of which a transaction pooler breaks), then runs
   `infra/hatchet/fly/secrets.sh` to see every command, fills in each placeholder — including
   `DATABASE_URL` with that string — from 1Password, and runs the `fly secrets set --stage ...`
   commands it prints. There is no `fly mpg attach` step here. Only three secrets are required
   (`DATABASE_URL`, `SERVER_AUTH_ADMIN_EMAIL`, `SERVER_AUTH_ADMIN_PASSWORD`); the script's
   `Optional overrides` block covers the four keyset and cookie secrets, which the engine
   otherwise generates itself into the volume created in step 3.
5. Deploy: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`
6. Check health: `curl -s https://<engine-app>.fly.dev/api/ready` should return 200. If the
   gRPC port refuses connections, check the `SERVER_GRPC_INSECURE` note in `fly.toml` first —
   Fly terminates TLS at the edge, so the engine's own setting may need to flip.
7. The CTO runs `fly ssh issue` once for the org, if that has not already been done.
8. Mint a worker token from this machine: `export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/fly/token.sh -a <engine-app>)"`.
   `token.sh` defaults to the tenant id the local stack seeds
   (`707d0855-80ab-4e1f-a156-f1c4546cbf52`); a fresh Fly instance is not confirmed to seed the
   same id. Read the real id off the dashboard's tenant settings first, and pass it with
   `--tenant-id` if it differs.
9. Register one worker against it (see `examples/shop/README.md`, "Against the deployed dev
   engine") and confirm it shows up in the dashboard.

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

_No rehearsal has been performed yet. Record each one here: date, source backup, destination
cluster, what was checked._

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
   volume in the wrong region, means `/config` starts empty — confirm after first deploy what
   that actually breaks.
6. If nothing above explains it, re-read the first-deploy steps for anything skipped or done out
   of order, then ask the CTO to check the secrets are all set.
