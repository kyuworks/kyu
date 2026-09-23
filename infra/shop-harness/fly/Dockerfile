# Container image for the shop failure harness, run in-region against the
# deployed dev engine <engine-app> (issue #166). Built only through the
# Fly remote builder (`fly deploy --build-only` / `fly deploy`) — never with
# a local `docker build`. Build context: the repository root, with
# harness.dockerignore as the allow-list.
FROM node:24-bookworm-slim

RUN npm install -g pnpm@11.24.0

WORKDIR /app

# Manifests (and each workspace package's own package.json) first, so an
# install-only layer survives a source-only change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY examples/shop/package.json examples/shop/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY examples/shop/ examples/shop/
COPY infra/hatchet/compose.yaml infra/hatchet/compose.yaml
COPY infra/shop-harness/fly/run.sh infra/shop-harness/fly/run.sh

# Project references build schemas, then sdk, then shop; the web UI
# (vite build) is skipped, the harness never needs it.
RUN pnpm --filter @kyuworks/shop exec tsc -b

# An image with no commit id fails to build, rather than shipping a report
# whose commitSha silently reads "unknown" (report.ts's readCommitSha).
ARG KYU_HARNESS_COMMIT_SHA
RUN test -n "$KYU_HARNESS_COMMIT_SHA"
ENV KYU_HARNESS_COMMIT_SHA=$KYU_HARNESS_COMMIT_SHA

CMD ["bash", "infra/shop-harness/fly/run.sh"]
