# Approach to concurrency and duplicate-assignment prevention

**Goal:** a service request can never have more than one live assignment, an agent can never hold more work than its
capacity, and retried or duplicated API calls never create duplicate requests or assignments — even with many API
instances, concurrent dispatchers, agents responding at the same moment as timeouts fire, and Redis locks expiring.

**Principle:** a Redis lock reduces contention, and MongoDB enforces correctness. Each layer below would be enough on
its own for some races; together they cover the failure modes of the others.

## 1. Per-request distributed lock (Redis)

All writes to one request (assign, auto-dispatch, accept, reject, start, complete, cancel, reassign, timeout,
offline revocation) run inside `withRequestLock(requestId)`:

```
SET lock:request:<id> <random-uuid> NX PX 10000      # acquire (atomic)
EVAL "if GET(key) == uuid then DEL(key) end"         # release only our own lock
```

API calls wait up to 3 seconds with jittered retries, so short bursts queue instead of failing. Background jobs do
not wait: they skip a busy request and retry on the next sweep. The lock lets requests for *different* service
requests run in parallel while keeping work on the *same* request in order.

## 2. Database invariants (hold even if the lock fails)

| Guard | Implementation | Prevents |
|---|---|---|
| One active assignment per request | Unique **partial** index on `assignments.request` where `active = true` | Two agents holding the same request |
| Agent capacity | `findOneAndUpdate({ _id, status:'online', $expr: { activeCount < maxConcurrent } }, { $inc: { activeCount: 1 } })` | Overbooking an agent from parallel offers of *different* requests |
| State transitions | Every transition is `findOneAndUpdate({ _id, status: <expected>, ... })` | Lost updates, e.g. accept after expiry, expiry after accept, assigning a cancelled request |
| Offer expiry | Accept requires `expiresAt > now`; expiry requires `status = 'offered'` | A late accept reviving a timed-out offer |

When a later step fails after an earlier one succeeded (for example the request was cancelled after the agent slot
was reserved), the code **compensates**: it deactivates the assignment it created and returns the agent's capacity.
This gives transaction-like behaviour without needing a MongoDB replica set.

The test suite runs the same 20-way race **with the Redis lock bypassed** and still gets exactly one assignment, with
every losing attempt releasing the capacity it reserved.

## 3. Idempotency for retried requests

Critical POSTs accept an `Idempotency-Key` header (required for create, assign and reassign):

1. `SET idem:<user>:<key> {state: processing, hash(method, path, body)} NX EX 60` atomically claims the key.
2. A concurrent duplicate gets `409 IDEMPOTENCY_IN_PROGRESS`.
3. A retry after success replays the stored response (`Idempotent-Replayed: true`, kept 24 hours).
4. Reusing the key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.
5. Failed (non-2xx) calls release the key so the client can retry safely.

Agent actions (accept, start, complete, reject) and cancel are idempotent by design: repeating an action that has
already been applied returns the current state (`replayed: true`) rather than an error or a second side effect.

## 4. Failure handling that keeps the invariants

- **Rejection / timeout / agent offline:** the assignment ends conditionally, capacity is returned, the agent is
  excluded from further offers for that request, and the request is immediately re-dispatched.
- **Offline detection:** heartbeats live in a Redis sorted set; stale agents are popped atomically with a Lua script so
  a heartbeat arriving during the sweep is never lost.
- **Bounded retries:** after `maxAttempts` offers or `maxPendingSec` without an agent, the request moves to `failed`.
- **Multiple API instances:** the sweeper takes a Redis leader lock, and each step is safe to run concurrently anyway.

## Verified by automated tests

- 20 simultaneous HTTP assigns of one request → 1 success, 19 conflicts, 1 active assignment.
- The same race with no Redis lock → still exactly 1 winner, no leaked capacity.
- 10 requests racing for one agent with capacity 2 → exactly 2 offers.
- 10 parallel auto-dispatches across 3 agents → exactly 3 offers, nobody over capacity.
- 10 concurrent creates with one Idempotency-Key → 1 stored request.
- Accept racing cancel, and late accept racing the timeout sweeper → always a consistent final state.
