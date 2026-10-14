# CodeZero session: explaining the dispatch flow

**Prompt:** *Explain how the dispatch flow works from POST /api/requests to an agent accepting the offer, and how duplicate assignments are prevented.*

CodeZero traced the flow by reading the local working tree (39 s, 8 tool calls). Its answer, unedited:

---

I traced the flow from POST /api/requests to an agent accepting the offer, reading the local working tree.

## 1. Create: POST /api/requests

Route at `backend/src/routes/index.ts:175`. Middleware order:

- `authorize('request:create')`: only admin or dispatcher can create.
- `idempotency({ required: true })`: the Idempotency-Key header is required. It atomically claims a Redis key (`SET idem:<user>:<key> … NX EX 60`).
  - A duplicate sent while the first is still running gets 409 `IDEMPOTENCY_IN_PROGRESS`.
  - A retry after success replays the stored response.
  - The same key with a different body gets 422.
  - A failed call releases the key.
- `validate(createRequestBody)`, then `createRequest()`.

`createRequest` (`backend/src/services/request.service.ts:23`):

- Gets a request code like `REQ-<n>` from a counter, then inserts the request with status `pending`.
- Writes an audit entry (`request.created`) and sends a socket update.
- If `cfg.autoDispatch` is on, it tries to dispatch straight away: `withRequestLock(id, autoDispatchUnlocked, 1000ms wait)`.
- If that fails, it logs and returns `dispatch: { outcome: 'queued' }`. The sweeper (`dispatchPendingQueue`, `dispatch.service.ts:790`) picks the request up later, highest priority first, then oldest.

## 2. Auto-dispatch: autoDispatchUnlocked (dispatch.service.ts:366)

- If the request is no longer `pending`, it returns `skipped`.
- If `attempts >= maxAttempts`, the request becomes `failed` with `MAX_ATTEMPTS_REACHED`.
- `findCandidates` (`:178`) ranks agents:
  - `$geoNear` search within a radius scaled by priority.
  - Hard filters: agent is online, has the right skill, has spare capacity, and is not in `triedAgents`.
  - Weighted score from distance, current workload and idle time (fairness). It keeps the top `candidateLimit`.
- It walks the candidates and calls `offerToAgentUnlocked` for each:
  - On `AGENT_UNAVAILABLE` (agent filled up or went offline since ranking), it moves to the next candidate.
- If no candidate takes it:
  - Request older than `maxPendingSec` → `failed` with `NO_AGENT_AVAILABLE`.
  - Otherwise → `waiting`, and the sweeper tries again later.

## 3. Offer: offerToAgentUnlocked (dispatch.service.ts:260)

The steps run in this order:

1. Load the request and check it is `pending`. Load the agent and check the skill matches.
2. Reserve a capacity slot with one conditional update: `findOneAndUpdate({ _id, status:'online', activeCount < maxConcurrent }, { $inc: { activeCount: 1 } })`. If nothing matches → `AGENT_UNAVAILABLE`.
3. Insert an Assignment with `status: 'offered'`, `active: true`, and `expiresAt = now + offerTimeoutSec` (set per priority).
   - If the insert hits a duplicate-key error, it frees the slot and throws `ALREADY_ASSIGNED`.
4. Move the request from `pending` to `offered` with a conditional update (`{ _id, status: 'pending' }`), setting `currentAssignment`, `assignedAgent` and incrementing `attempts`.
   - If nothing matches (the request was cancelled, or another offer won), it compensates: marks the new assignment `cancelled` / `active: false`, frees the slot, and throws `INVALID_STATE`.
5. Bumps `stats.offered`, writes an audit entry, and publishes socket events. `publishOffer` produces `assignment:offered`, which shows a toast and an offer card on the agent page (`frontend/src/pages/AgentPage.tsx:39`).

## 4. Accept: POST /api/assignments/:id/accept

Handled by `progressAssignment(id, actor, 'accept')` (`dispatch.service.ts:493`):

- `loadOwnAssignment` returns 403 if the assignment belongs to a different agent.
- Under the request lock, it runs a conditional update on the assignment:
  `{ _id, agent, status: 'offered', active: true, expiresAt: { $gt: now } }` → status `'accepted'`, `respondedAt`
- If nothing matches, it re-reads the assignment:
  - Already accepted → returns `replayed: true` (repeating the call is safe).
  - Still offered → the offer has timed out: 409 `OFFER_EXPIRED`.
  - Anything else → `INVALID_STATE`.
- Then it updates the request conditionally: `{ currentAssignment: this, status: 'offered' }` → `'accepted'`. If that fails, it ends the assignment so the data stays consistent.
- Audit entry and socket publish.

**Other paths:**

- **Reject:** `rejectAssignment` ends the assignment, frees the slot, puts the request back to `pending`, adds the agent to `triedAgents`, and re-dispatches immediately.
- **Timeout:** the sweeper's `expireDueOffers` does the same, but only if `status: 'offered'` and `expiresAt <= now`. A late accept and the expiry can't both succeed.

## How duplicate assignments are prevented

There are two layers: a Redis lock to cut contention, and MongoDB conditions that guarantee correctness on their own (see `docs/CONCURRENCY.md`).

| Layer | Mechanism | Stops |
|---|---|---|
| Redis per-request lock | `withRequestLock`: `SET lock:request:<id> uuid NX PX` and a Lua script that only deletes the lock if the caller owns it. API calls wait up to 3s; sweeper jobs skip busy requests (`waitMs=0`). | Writes to the same request running at the same time; different requests still run in parallel |
| Unique partial index | `uniq_active_assignment_per_request` on `{request:1}` where `active: true` (`backend/src/models/Assignment.ts:53`) | A second live assignment for a request. This is the final guarantee. |
| Atomic capacity reservation | Conditional `$inc` on `activeCount < maxConcurrent` | Overbooking an agent through parallel offers for different requests |
| Conditional state transitions | Every change is `findOneAndUpdate({ status: <expected> })` | Lost updates: accept after expiry, expiry after accept, assigning a cancelled request |
| Compensation | Whoever loses the race deactivates its assignment and frees the slot | Leaked capacity or orphaned assignments (no Mongo transactions needed) |
| `triedAgents` | `$addToSet` on reject, expiry or revoke | Re-offering the same request to an agent that already declined or let it lapse |
| Idempotency keys | Required on create, assign and reassign; accept, reject, start, complete and cancel are idempotent by design | Client retries creating duplicate requests or offers |

The lock is the "fast path". If it expires partway through (10s TTL), or is bypassed entirely, the unique index and conditional updates still allow only one winner. `backend/tests/concurrency.test.ts` runs a 20-way assign race with the lock bypassed and gets exactly one assignment and no leaked capacity.

**Small gaps I spotted (not bugs in the duplicate-assignment guarantee):**

- On accept, `stats.accepted` is incremented before the request update (`dispatch.service.ts:513`). If that request update ever fails, the agent's stat stays inflated.
- If the immediate dispatch in `createRequest` fails, it is only logged (`request.service.ts:54`). The client is told `queued`, and the request waits for the next sweeper run.
