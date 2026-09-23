# Engine run list keeps ended runs as queued or running (issue #170)

The engine's run list can report a run as queued or running for good after the engine has ended
it. This page records what was seen, what was tried, and what the SDK now does about it, so the
defect can be raised upstream at the next engine upgrade.

- Engine: hatchet-lite `v0.107.0` (local, `infra/hatchet/compose.yaml`; Fly dev, `infra/hatchet/fly/fly.toml`).
- Engine SDK: `@hatchet-dev/typescript-sdk` `1.32.0`.
- Read on 2026-09-23 against the local engine's own database (`hatchet`, Postgres on `localhost:15432`).

## Two copies of a run's state

The engine keeps a run's state twice:

| Copy | Tables | Read by |
|---|---|---|
| The engine's own task state | `v1_task`, `v1_task_event` (terminal events `COMPLETED`, `FAILED`, `CANCELLED`), `v1_queue_item`, `v1_retry_queue_item`, `v1_task_runtime` | gRPC `AdminService.GetRunDetails`, reached through `runs.getDetails` (`v1/client/features/runs.js:133-137`) |
| The run list's copy | `v1_runs_olap`, `v1_tasks_olap` (`readable_status`), `v1_task_events_olap` | REST `v1WorkflowRunList` through `runs.list` (`v1/client/features/runs.js:145-150`, `clients/rest/generated/Api.js:118`), and also `v1WorkflowRunGetStatus` and `v1TaskGet` (`Api.js:28`) |

The list's copy is written from events the engine sends after it has written its own state. A run
whose last event never reaches the list stays at the list's last status.

## What was seen

On the local engine, 294 runs from the 2026-09-22 tenant-load runs (issue #144, namespaces
`kyulane144_tenant_load_526de3_`, `_e72fda_`, `_6cec13_`) listed as RUNNING (199) or QUEUED (95).
None of them had a row in `v1_task_runtime`, `v1_queue_item` or `v1_retry_queue_item`, and
`v1_task_events_olap_tmp` and `v1_task_status_updates_tmp` were empty, so no list update was still
waiting to be applied. They fall into two kinds:

| Kind | Count | Engine task state | Run detail (`runs.getDetails`) | Run list |
|---|---|---|---|---|
| A — the list missed the final step | 99 (`record-order` 65, `audit-order` 19, `send-invoice` 9, `watch-shipping` 6) | `COMPLETED` event present | `COMPLETED`, `done: true` | RUNNING or QUEUED |
| B — the engine lost the scheduling timeout | 195 (`watch-shipping`, durable) | only `SIGNAL_COMPLETED`; no terminal event and nothing queued | `QUEUED`, `done: false` | RUNNING or QUEUED |

Kind B runs all follow one pattern in `v1_task_events_olap`: the worker stopped while the run was
parked (`DURABLE_EVICTED`), the wait was satisfied (`DURABLE_RESTORING`, core `SIGNAL_COMPLETED`),
no worker was left (`REQUEUED_NO_WORKER`), and five minutes later — the default schedule timeout —
a second `REQUEUED_NO_WORKER` was written where a normal run gets `SCHEDULING_TIMED_OUT` and a core
`CANCELLED`. The queue item is gone, so no worker will ever take the run, but the engine's own state
still says it is queued. Its durable log (`v1DurableTaskEventLogList`, `Api.js:168`) shows every
wait satisfied, which a live evicted run waiting for a worker also shows, so no read tells kind B
from a live queued run.

Of the 98 kind A runs still listed when this was measured (one had been cancelled, see below), 66
completed 1–16 seconds before a stretch of 11–59 seconds in which the engine wrote no task events at
all (for example: 13 runs completed at 01:15:21–22 UTC, no events 01:15:37–01:16:21; 9 at 02:01:42,
none 02:01:45–02:02:39). The other 32 completed at 02:00:30–33, 40 seconds before the next such
stretch. All the kind B runs got their second `REQUEUED_NO_WORKER` within the same 0.1 seconds at
02:01:34.9 — one batch — eleven seconds before the 02:01:45 stretch. The tenant-load runs of issue #144 were
recorded as killing the laptop engine for memory several times per run. This lines up with the
engine stopping between writing its own state and writing the list's copy. It is strongly
indicated, not proven: the engine's own logs for that night were not kept.

On the Fly dev engine, 18 runs under `inregion166_tenant_load_593c3d_` stayed listed after a
namespace cancel (`docs/proofs/2026-09-23-shop-failure-harness-fly-dev.md`, issue #165). That page
records no engine restart after 2026-09-22T13:10Z, so a restart may not be the only way to lose the
write; heavy load with dispatcher and heartbeat errors was logged in that run. The Fly engine's
database was not read, so which kind those 18 are is unknown.

## Cancelling a stale run

Two stale runs were cancelled by id on 2026-09-23, one of each kind
(`ee576bfa-131c-4106-aa07-9112e27a4cb9`, kind A; `8080b112-0dad-491c-82b4-38523496fbe8`, kind B).
The engine returned both ids; within 8 seconds the run detail and the list both read CANCELLED, and
`v1_task_event` gained a `CANCELLED` event after the existing `COMPLETED` (kind A) or
`SIGNAL_COMPLETED` (kind B). So a cancel by id does end both kinds locally, and it rewrites a kind A
run that had completed as cancelled. The namespace-wide cancel (by filter) was not tried on these
runs. 292 remain on the local engine as evidence.

## Reproduction attempts from a fresh namespace

Each attempt ran against the local engine in a throwaway namespace (`plan170_<hex>_`), using the
engine SDK directly, with `scheduleTimeout: '20s'` so a stuck run would show within a minute:

| Sequence | Run list, ~60 s later | Run detail | Engine task state |
|---|---|---|---|
| Plain task, worker SIGKILLed mid-run | FAILED | CANCELLED | `REASSIGNED` then `SCHEDULING_TIMED_OUT`; core `CANCELLED` |
| Durable run parked in a wait, worker stopped gracefully (evicted), wait's event pushed with no worker | FAILED | CANCELLED | `DURABLE_EVICTED`, `DURABLE_RESTORING`, `SCHEDULING_TIMED_OUT`; core `SIGNAL_COMPLETED`, `CANCELLED` |
| Durable run parked in a wait, worker SIGKILLed, event pushed | FAILED | CANCELLED | `REASSIGNED`, `REQUEUED_NO_WORKER`, `SCHEDULING_TIMED_OUT`; core `SIGNAL_COMPLETED`, `CANCELLED` |
| Task that fails its first attempt, retry pending, worker SIGKILLed | FAILED | CANCELLED | `FAILED`, `RETRYING`, `REQUEUED_NO_WORKER`, `SCHEDULING_TIMED_OUT`; core `CANCELLED` |
| Control: task that completes | COMPLETED | COMPLETED | `FINISHED`; core `COMPLETED` |

Every sequence settled. None of them leaves a stale row without the engine itself stopping, and
stopping the engine is not something a test in this repository may do (no Docker changes). So the
defect is not reproduced from a fresh namespace; this page is the finding.

Two things the attempts did show: while the engine is catching up, the list and the run detail can
disagree for a few seconds (a SIGKILLed run read RUNNING in the list and QUEUED in the detail for
about 30 seconds before both settled); and a scheduling timeout reads FAILED in the list but
CANCELLED in the run detail, for good.

## What the SDK does

`runs.forEnvelope`, `runs.forCorrelation`, `runs.cancelForEnvelope`, `runs.cancelForCorrelation`
and `runs.unsettledInNamespace` read the run list. For a row the list has shown queued or running
for more than 60 seconds (from its `startedAt`, or `createdAt` when it has not started), they also
read the run detail, once per such row and at most 100 rows per call. When the detail says
COMPLETED or FAILED, the run reads `completed` or `failed`, with no `finishedAt` if the list never
recorded one, and `unsettledInNamespace` leaves it out. A CANCELLED detail is not used, because the
engine reports a scheduling timeout as CANCELLED there and FAILED in its list. Kind B runs still
read queued or running: nothing the engine exposes says they are stuck. `cancelUnsettledInNamespace`
is unchanged.

## Queries

Stale runs by kind (run against the engine's own database, read only):

```sql
select r.readable_status, t.is_durable,
  exists (select 1 from v1_task_event e where e.task_id = t.id and e.task_inserted_at = t.inserted_at
          and e.event_type = 'COMPLETED') as core_completed,
  count(*)
from v1_runs_olap r
join v1_lookup_table l on l.external_id = r.external_id
join v1_task t on t.id = l.task_id and t.inserted_at = l.inserted_at
where r.readable_status in ('QUEUED', 'RUNNING')
  and not exists (select 1 from v1_task_runtime x where x.task_id = t.id)
  and not exists (select 1 from v1_queue_item x where x.task_id = t.id)
  and not exists (select 1 from v1_retry_queue_item x where x.task_id = t.id)
group by 1, 2, 3;
```

One run's history in both copies:

```sql
select 'list' as copy, event_type::text, event_timestamp from v1_task_events_olap
 where task_id = :task_id and task_inserted_at = :task_inserted_at
union all
select 'engine', event_type::text, created_at::timestamptz from v1_task_event
 where task_id = :task_id and task_inserted_at = :task_inserted_at
order by 3;
```

## To raise upstream

Title: "Run list (OLAP) keeps a run QUEUED/RUNNING after the engine completed it or lost its
scheduling timeout (v0.107.0)". Attach both tables above, the kind B event sequence, and the
cancel result. Ask whether the OLAP copy is meant to be repaired from core state after a restart,
and whether a scheduling timeout that removed the queue item but never wrote `CANCELLED` is
recovered anywhere.
