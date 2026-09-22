# Running the Kyu engine on Fly

This page covers the deployed Hatchet engine for the Kyu message bus: `infra/hatchet/fly/`
(issue #162). It does not cover the local stack — see `infra/hatchet/compose.yaml` and
`infra/hatchet/token.sh` for that.

Today there is one environment: dev, app `<engine-app>`, org `<fly-org>`, region `syd`.

## Who does what

- The CTO sets every secret and is the only one who runs `fly ssh issue` for the org. No agent
  reads a secret back or signs in to Fly.
- An engineer (or an agent, for the parts that do not touch a secret) creates Fly resources,
  writes config, deploys, and checks the result.

## First deploy

1. Create the app: `fly apps create <engine-app> -o <fly-org>`
2. Create the managed Postgres cluster: `fly mpg create -o <fly-org> -n <engine-db> -r syd --plan Basic --pg-major-version 17 --volume-size 10`
3. The CTO attaches the cluster to the app (`fly mpg attach <cluster id> -a <engine-app>`,
   which writes the `DATABASE_URL` secret) and runs `infra/hatchet/fly/secrets.sh` to see the
   remaining commands, filling in each placeholder with a value from 1Password, then runs the
   `fly secrets set --stage ...` commands it prints.
4. Deploy: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`
5. Check health: `curl -s https://<engine-app>.fly.dev/api/ready` should return 200. If the
   gRPC port refuses connections, check the `SERVER_GRPC_INSECURE` note in `fly.toml` first —
   Fly terminates TLS at the edge, so the engine's own setting may need to flip.
6. The CTO runs `fly ssh issue` once for the org, if that has not already been done.
7. Mint a worker token from this machine: `export HATCHET_CLIENT_TOKEN="$(bash infra/hatchet/fly/token.sh -a <engine-app>)"`
8. Register one worker against it (see `examples/shop/README.md`, "Against the deployed dev
   engine") and confirm it shows up in the dashboard.

## Upgrade

1. Take a snapshot: `fly mpg backup list` and, if the platform does not do this automatically,
   trigger one first.
2. Bump the image tag in `infra/hatchet/fly/fly.toml` and `infra/hatchet/compose.yaml` together
   — they must always name the same tag.
3. Deploy dev: `fly deploy -c infra/hatchet/fly/fly.toml -a <engine-app>`
4. Soak for a day: watch the dashboard, worker logs, and `/api/ready` for anything unusual.
5. Only then promote the same tag to any later environment.

## Backup and restore rehearsal

1. List available backups: `fly mpg backup list`
2. Restore into a **new** cluster — never onto the live one: `fly mpg restore`, choosing a
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
   A recent restart on a machine with no working `/config` volume means every previously minted
   worker token has stopped verifying (the engine regenerated its signing keys).
2. `fly logs -a <engine-app>` — look for a crash loop, a database connection error, or a
   migration failure at start.
3. `curl -s https://<engine-app>.fly.dev/api/ready` — is the API answering at all?
4. `fly mpg status -n <engine-db>` — is the database cluster itself healthy?
5. Check the volume: has the machine been replaced? A replacement with no volume attached, or a
   volume in the wrong region, breaks the engine's signing keys the same way as point 1.
6. If nothing above explains it, re-read the first-deploy steps for anything skipped or done out
   of order, then ask the CTO to check the secrets are all set.
