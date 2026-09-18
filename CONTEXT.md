# Shared language

`AGENTS.md` is the law. This file is the glossary. Use these words in issues, PRs, code names and comments. Do not invent synonyms.

## The bus

| Word | Meaning |
| --- | --- |
| Qtaxis | This system: the company message bus. Q for queue plus taxis, the biology term for directed movement toward a stimulus. Formerly Kinesin; renamed on 2026-09-18. |
| engine | Hatchet, self-hosted. Qtaxis's control plane. Never exposed to consumer code directly; the SDK wraps it. |
| message | One envelope on the bus. Either an event or a command. |
| event | A fact that happened in a producer, fanned out to every subscriber. Named in past tense: `shop.order.placed`. |
| command | Work for exactly one handler, retried until it succeeds or is parked. Named in imperative: `shop.invoice.send`. |
| envelope | The company-standard wrapper around every message: id, name, version, kind, occurredAt, tenantId, correlationId, causationId, source, data. Defined once in `@qtaxis/schemas`. |
| name | `<project>.<aggregate>.<verb>`, lower case, dots only. |
| producer | A project that publishes messages. |
| consumer | A project that runs a worker and subscribes to messages. |
| handler | The function a subscription runs for one message. Always idempotent on the envelope id. |
| subscription | A consumer's declaration: which message name, with what concurrency, retries and rate limits. One Hatchet task under the hood. |
| durable handler | A handler that can sleep and wait for correlated events across restarts. One Hatchet durable task. |

## Delivery

| Word | Meaning |
| --- | --- |
| outbox | The `qtaxis_outbox` table in a producer's own database. `publish()` writes there inside the caller's transaction. |
| relay | The loop in the producer process that ships outbox rows to the engine and marks them published. |
| at-least-once | The only delivery guarantee. A handler may see the same envelope id twice. |
| processed table | `qtaxis_processed` in a consumer's database. `onceById()` records handled ids there, inside the handler's transaction. |
| concurrency key | A CEL expression on the payload or metadata that groups runs. `maxRuns: 1` per key gives FIFO per key. |
| coalescing | `CANCEL_IN_PROGRESS` (only the newest run matters) or `CANCEL_NEWEST` (drop if one is already running). |
| failed run | The dead letter. Alerted on, replayable from the dashboard, never silently dropped. |

## Tenancy

| Word | Meaning |
| --- | --- |
| bus tenant | A Hatchet tenant. One per company project per environment. Holds worker tokens. |
| business tenant | `tenantId` on the envelope: a customer organisation in the producer's own model. Never a Hatchet concept. |
| ids-only | Payloads carry identifiers and small discriminators. Consumers load state from their own database. |

## Shipping

| Word | Meaning |
| --- | --- |
| main | The only long-lived branch. PRs target it. |
| gate | A check that fails the commit or the PR. Prefer a gate over a review comment. |
| check:changed | The quiet local verify loop. Silent on success. |
| RED₁ / GREEN / RED₂ | A test seen failing before the change, passing after it, failing again with the change removed. |
| stack | The local Hatchet Lite + Postgres containers from `infra/hatchet/compose.yaml`. |
