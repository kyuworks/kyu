Review mode: fresh | delta
Artifact type: plan | code
Register path: .artifacts/reviews/<branch-slug>/findings-register.md
Reviewed head SHA:
Reviewed scope state: clean | HEAD plus worktree changes
Closeout state: active
Pull request: none
Scope:
- ...

Changed sections:
- ...

Active findings:
| ID | Severity | Status | Finding | Why it matters | Recommendation | Proof needed to close | Watch-outs |
|---|---|---|---|---|---|---|---|
| F-01 | blocking | open | ... | ... | ... | ... | ... |
| F-02 | medium | open | ... | ... | ... | ... | ... |

Status vocabulary:
- `open`: not yet addressed
- `claimed fixed`: implementation side believes it is resolved; the delta review still must verify
- `partially addressed`: some work landed but proof to close is still incomplete
- `blocked`: needs a user decision, missing capability, or larger follow-up
- `closed after review`: a delta review verified closure

Closeout state vocabulary:
- `active`: review or implementation is in progress
- `ready for delivery`: findings are disposed and delivery evidence is pending
- `delivered`: applicable commit, push, and PR-body evidence is recorded below

Implementation update:
- Changed artifacts:
  - ...
- Changed sections:
  - ...
- Finding statuses:
  - F-01: claimed fixed
  - F-02: partially addressed
- Assumptions or blockers:
  - ...

Delta review rules:
- Review active findings first.
- Inspect only changed sections and direct dependency areas.
- For each active finding, return exactly one:
  - fixed
  - still open
  - replaced by narrower issue
- Add new findings only if directly introduced or newly exposed by the recent change.

Why new now labels:
- introduced by recent change
- previously latent, now exposed
- missed in prior review

Exit rule:
- no blocking findings remain open
- no rollout contradictions remain
- any claim that an existing SDK helper or Hatchet feature supports something has a real file or documentation reference

Expected output:
- F-01: fixed | still open | replaced by narrower issue
- F-02: fixed | still open | replaced by narrower issue
- New findings:
  - none
  - or list each with a why-new-now label

Delivery closeout:
- Scoped commands and outcomes:
  - pending
- Commit SHA: pending
- Pushed branch and SHA: pending
- PR body: not applicable | pending | refreshed at <SHA>, <URL>
