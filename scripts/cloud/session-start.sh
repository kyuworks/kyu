#!/usr/bin/env bash
# SessionStart — make a cloud session ready to verify code.
#
# No-op on a laptop: the environment already exists there. In the cloud
# (CLAUDE_CODE_REMOTE=true) install dependencies and build the workspace so
# typecheck and tests are trustworthy. The Hatchet stack is not started here:
# integration tests need Docker, which a cloud session may not have. They
# fail loudly without it rather than skipping.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 0
step() { printf '→ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*"; }
step "Checking the toolchain"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is not on PATH. Enable corepack or install pnpm 11."
bash scripts/lib/check-node-engine.sh || fail "Node is older than package.json engines.node."
step "Installing dependencies"
pnpm install --frozen-lockfile || fail "pnpm install failed. Typecheck and tests will not be trustworthy."
step "Building the workspace"
pnpm build || fail "pnpm build failed."
step "Session ready"
exit 0
