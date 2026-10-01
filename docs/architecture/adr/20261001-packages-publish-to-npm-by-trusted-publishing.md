# Both packages publish to public npm from a tag on main by trusted publishing

**Status:** accepted on 2026-10-01 (CTO, issue #2)
**Date:** 2026-10-01
**Parent:** [#2](https://github.com/kyuworks/kyu/issues/2)
**This is not** a decision about the envelope, the exported API or the migrations. It decides where the two packages are published and how a release is cut.

`@kyuworks/schemas` and `@kyuworks/sdk` are public npm packages under the `@kyuworks` scope, released together from a `v<version>` tag on `main` by npm trusted publishing with provenance, with no token anywhere.

---

## Context

Every company project consumes the SDK, and nothing was installable: both manifests were `0.0.0` and `UNLICENSED`, and no workflow published. The repository `kyuworks/kyu` is public, and the `@kyuworks` scope is registered on npm. Provenance attestations require a public source repository and a public package. npm can trust one GitHub workflow per package, so no stored token is needed. The SDK depends on schemas as `workspace:*`, which `pnpm publish` rewrites to the exact version.

---

## Options considered

**A. GitHub Packages.** Needs the repository owner as the scope, and every consumer needs a token to install. It lost on both.

**B. Restricted npm packages.** Paid, and every consumer needs a token to install. It lost.

**C. A git-tag dependency.** No registry, but no built output, no provenance and no version resolution. It lost.

**D. Public npm, trusted publishing, tag-driven.** One install command for consumers, provenance, no secret to leak or rotate. It won.

---

## Decision

1. **Public npm under `@kyuworks`, licence MIT.** `publishConfig.access` is `public` in both manifests.
2. **Lockstep versions.** Both manifests and `SDK_VERSION` carry one version. A bump is a reviewed PR; `check-package-versions.sh` fails a mismatch.
3. **A tag publishes.** A `v<version>` tag on a commit that is on `main` and passed CI there runs `release.yml`, which checks the tag, checks the tarballs (`check-package-exports.sh`) and publishes with `pnpm publish --provenance`.
4. **No token.** npm trusts the `release.yml` workflow of this repository on each package. The workflow references no secret.
5. **First publish is manual.** npm needs the package to exist before a trusted publisher can be set, so the CTO reserves each name once from their own machine (README, "First release only").

---

## Consequences

**Positive**

- A project installs the SDK with one command and can verify where the build came from.
- No credential exists to leak, rotate or hand to an agent.
- A broken tarball fails a gate before a release, not after.

**Negative**

- The first publish of each name needs a CTO placeholder.
- A consumer on pnpm 11 waits a day for a new release unless it excludes `@kyuworks/*` from `minimumReleaseAge`.
- A version bump touches three files.

---

## Do not

- Add an npm token or any publish secret to the repository or to Actions.
- Publish from a branch, from a laptop (after the first placeholder) or from a commit not on `main`.
- Let the two packages carry different versions.

---

## Reopen when

- The repository becomes private, or npm drops trusted publishing for GitHub Actions.
