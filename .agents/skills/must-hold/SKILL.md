---
name: must-hold
description: >
  Name what must stay true in a code path, then turn one item into a test
  this repo can run. Use when the user says /must-hold, "what must hold",
  "name the invariants", "correctness list", or before writing tests for a
  publish path, handler, relay loop, webhook, retry, crash-recovery, or a
  bugfix (list one already-true behaviour plus the fix; one test covers
  both). Do not use for copy, docs, or renames with no behavior.
---

# Must hold

Write down what “correct” means. Then turn **one** item into a test this
repo already knows how to run.

Two steps. Do not skip the list.

This is not a new test runner and not another company’s platform. Tests
live next to the code, the way they already do.

## When

**Use when:**

- `/must-hold`
- “what must hold”, “name the invariants”, “correctness list”
- adding or changing a publish path, a handler, the outbox relay, a webhook, a retry, or crash-recovery
- a bugfix — the list must include one behaviour that is already true and must stay true
- the user wants tests that catch real faults, not a second copy of the happy path
- an agent is changing behavior — agents may not skip this skill. Humans may shortcut a typo PR. See `AGENTS.md` § Agent ship loop.

**Do not use when:**

- the change is copy, docs, or a rename with no behavior (mark N/A on the agent ship loop)

## Step 1 — Write the list

If the scope is unclear, ask. One subsystem, not the whole bus.

Look at the same code through these lenses. Skip a lens that does not apply,
and say why in one line.

1. Data stays consistent
2. Two things at once
3. Crash and restart
4. The API contract
5. Limits (queues, page size, pools)
6. Who is allowed
7. Tenant / office isolation
8. Startup, shutdown, migrate
9. Retries and duplicates
10. Old and new versions together
11. Whatever those missed

Do not copy rules that already live in [`AGENTS.md`](../../../AGENTS.md)
(`AGENTS.md` § Architecture and § Delivery rules: validate the envelope once
at the trust edge, ids-only payloads, outbox rows inside the caller's
transaction). Point at them.

These four rows are mandatory whenever the code path touches them. Say
which apply:

| Name | Must |
| --- | --- |
| `redelivery-idempotent` | At-least-once redelivery of the same envelope id is idempotent: the handler's effect happens once. |
| `rollback-never-delivers` | A message published inside a transaction that rolls back is never delivered. |
| `tenant-id-unchanged` | The business tenant id on the envelope reaches the handler unchanged. |
| `per-key-ordering` | Per-key ordering holds under concurrency: two messages with the same key are handled in publish order. |

A comment or doc is a **claim to check**, not a fact.
A GitHub issue is a **lead**. Confirm the defect in the code before you
build a test around it.

Each item:

| Field | What to write |
| --- | --- |
| **Name** | short kebab-case id |
| **Must** | one sentence: never happens / eventually happens / this path is hittable |
| **Where** | file and function |
| **Why** | one sentence |
| **Kind** | `never` · `eventually` · `reachable` |

Show the list. Do not write a new markdown file into the repo unless the
user asks.

**Bugfix:** the list includes one item that is already true and must stay true, plus the broken behaviour. Do not list only the new fix.

If you can spawn a subagent, give a **fresh** one the list and the code
(not your notes) and ask:

- what is missing
- what is already covered by an existing test
- what we cannot observe without a new hook

Apply the answers. Present anything that needs a human judgment as a
question, not as a silent choice.

## Step 2 — Turn one item into a test

Recommend the **simplest** item first, not the most important, so the loop
is proven. Say why you picked it. Wait for confirmation. On a bugfix, do
not wait and do not pick only the already-true item.

Write a test this repo already runs (`AGENTS.md` § Who runs which tests):

- colocated `*.test.ts` next to the code, run with `pnpm --filter <pkg> test`
- `*.integration.test.ts` if it needs a real Hatchet or Postgres, run with
  `pnpm --filter @kinesin/sdk test:integration` against the local stack from
  `infra/hatchet/compose.yaml` (`pnpm hatchet:up`)

Do not add a runner. Do not add an SDK. Do not write a check that only
fires on another platform.

**Rules for the test**

1. One item. Stop. Bugfix exception: the list has two items (already-true + broken); that is still one pass — **one** test that asserts both.
2. On a bugfix, write that one test, then the fix. Do not wait for confirmation and do not pick only the already-true item.
3. When the environment can drop work, assert a **range** (attempted vs
   acknowledged), not exact equality.
4. Feed awkward values, not a random spread: empty, one, just under the
   limit, the limit, just over, way over. Take the limits from this code
   (relay batch size, retry counts, backoff caps, concurrency `maxRuns`).
5. Include a check that the interesting state was **actually reached**. If
   that check never fires, the test is too weak — fix the test, not the
   product.
6. Keep going through a timeout or a retry. A transient error is not a
   product bug by itself.

## Fail if

- You wrote tests without a list
- You implemented more than one item in one pass (a bugfix test that asserts already-true **and** the fix is one pass)
- The test only covers the happy path
- The change is a bugfix and the list has no already-true item
- The bugfix test covers only the new behaviour
- You created an `antithesis/` tree or a catalog of markdown that nothing runs

## Do not

- Join or wrap another testing service
- Invent a second shape next to the envelope schema in `packages/schemas/src`
- Re-parse a value the layer above already validated
