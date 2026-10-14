import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, newIdempotencyKey } from '../lib/api';
import { clockTime, describeEvent, timeAgo, titleCase } from '../lib/format';
import type { Assignment, AuditEvent, Candidate, DispatchOutcome, ServiceRequest } from '../lib/types';
import { EVENT_COLOR } from './ActivityFeed';
import { BoltIcon, CloseIcon, PriorityTag, RefreshIcon, StatusBadge, useNow, useToast } from './ui';

interface Props {
  request: ServiceRequest;
  onClose: () => void;
}

export function RequestDrawer({ request, onClose }: Props) {
  const toast = useToast();
  const now = useNow(5000);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [timeline, setTimeline] = useState<AuditEvent[]>([]);
  const [candidates, setCandidates] = useState<{ radiusKm: number; candidates: Candidate[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const assignable = ['pending', 'offered', 'accepted'].includes(request.status);
  const cancellable = ['pending', 'offered', 'accepted', 'in_progress'].includes(request.status);

  const load = useCallback(async () => {
    const [detail, audit] = await Promise.all([
      api<{ assignments: Assignment[] }>(`/requests/${request.id}`),
      api<{ data: AuditEvent[] }>(`/audit?requestId=${request.id}&limit=100`),
    ]);
    setAssignments(detail.assignments);
    setTimeline(audit.data.slice().reverse());
    if (assignable) setCandidates(await api(`/requests/${request.id}/candidates`));
    else setCandidates(null);
    // updatedAt is a dependency on purpose: any live change to the request refreshes the drawer.
  }, [request.id, request.status, request.updatedAt, assignable]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const msg = await fn();
      if (msg) toast({ kind: 'success', title: msg });
    } catch (err) {
      toast({ kind: 'error', title: 'Action failed', body: err instanceof ApiError ? `${err.code}: ${err.message}` : String(err) });
    } finally {
      setBusy(null);
      load().catch(() => undefined);
    }
  };

  const describe = (d: DispatchOutcome) =>
    d.outcome === 'offered' ? `Offered to ${d.assignment?.agentName}` : d.outcome === 'waiting' ? 'No eligible agent — queued' : titleCase(d.outcome);

  const autoDispatch = () =>
    run('auto', async () => {
      const path = request.status === 'pending' ? 'dispatch' : 'reassign';
      const r = await api<{ dispatch: DispatchOutcome }>(`/requests/${request.id}/${path}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: path === 'reassign' ? { reason: 'Reassigned from dashboard' } : undefined,
      });
      return describe(r.dispatch);
    });

  const assignTo = (c: Candidate) =>
    run(c.agentId, async () => {
      if (request.status === 'pending') {
        await api(`/requests/${request.id}/assign`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body: { agentId: c.agentId } });
      } else {
        await api(`/requests/${request.id}/reassign`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: { agentId: c.agentId, reason: 'Manually reassigned from dashboard' },
        });
      }
      return `Offered to ${c.name}`;
    });

  const cancel = () =>
    run('cancel', async () => {
      await api(`/requests/${request.id}/cancel`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body: { reason } });
      setCancelling(false);
      return `${request.code} cancelled`;
    });

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={`Request ${request.code}`}>
        <div className="drawer-head">
          <div>
            <div className="row">
              <span className="mono muted">{request.code}</span>
              <StatusBadge status={request.status} />
              <PriorityTag priority={request.priority} />
            </div>
            <h3>{request.title}</h3>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          <section>
            <h4 className="section-title">Details</h4>
            <dl className="kv">
              <dt>Category</dt>
              <dd>{titleCase(request.category)}</dd>
              <dt>Location</dt>
              <dd className="mono">
                {request.location.lat.toFixed(5)}, {request.location.lng.toFixed(5)}
              </dd>
              {request.address && (
                <>
                  <dt>Address</dt>
                  <dd>{request.address}</dd>
                </>
              )}
              <dt>Assigned to</dt>
              <dd>{request.assignedAgentName ?? '—'}</dd>
              <dt>Offers made</dt>
              <dd>{request.attempts}</dd>
              <dt>Created</dt>
              <dd>{timeAgo(request.createdAt, now)}</dd>
              {request.failureReason && (
                <>
                  <dt>Failure</dt>
                  <dd style={{ color: 'var(--danger)' }}>{request.failureReason.replace(/_/g, ' ').toLowerCase()}</dd>
                </>
              )}
              {request.cancelReason && (
                <>
                  <dt>Cancel reason</dt>
                  <dd>{request.cancelReason}</dd>
                </>
              )}
              {request.description && (
                <>
                  <dt>Notes</dt>
                  <dd>{request.description}</dd>
                </>
              )}
            </dl>
          </section>

          {candidates && (
            <section>
              <div className="row between" style={{ marginBottom: 10 }}>
                <h4 className="section-title" style={{ margin: 0 }}>
                  Ranked candidates <span className="muted">· {candidates.radiusKm} km radius</span>
                </h4>
                <button className="btn btn-ghost btn-sm" onClick={() => load()} aria-label="Refresh candidates">
                  <RefreshIcon size={14} />
                </button>
              </div>
              <div className="score-legend">
                <span>
                  <i style={{ background: '#4f8cff' }} />
                  Distance
                </span>
                <span>
                  <i style={{ background: '#a47cff' }} />
                  Workload
                </span>
                <span>
                  <i style={{ background: '#2bc4d8' }} />
                  Fairness
                </span>
              </div>
              {candidates.candidates.length === 0 ? (
                <div className="empty" style={{ padding: 16 }}>
                  No eligible agent online with this skill inside the radius.
                </div>
              ) : (
                <div className="candidates">
                  {candidates.candidates.map((c, i) => {
                    const sum = c.score.distance + c.score.workload + c.score.fairness || 1;
                    return (
                      <div key={c.agentId} className="candidate">
                        <div>
                          <div>
                            <span className="rank">#{i + 1}</span>
                            <b>{c.name}</b>
                            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                              {c.distanceKm.toFixed(2)} km · {c.activeCount}/{c.maxConcurrent} load
                            </span>
                          </div>
                          <div className="scorebar" title={`score ${c.score.total}`}>
                            <span style={{ width: `${(c.score.distance / sum) * c.score.total * 100}%` }} />
                            <span style={{ width: `${(c.score.workload / sum) * c.score.total * 100}%` }} />
                            <span style={{ width: `${(c.score.fairness / sum) * c.score.total * 100}%` }} />
                          </div>
                        </div>
                        <div className="row">
                          <span className="mono">{c.score.total.toFixed(2)}</span>
                          <button className="btn btn-sm" disabled={busy !== null} onClick={() => assignTo(c)}>
                            {busy === c.agentId ? '…' : request.status === 'pending' ? 'Assign' : 'Reassign'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {assignments.length > 0 && (
            <section>
              <h4 className="section-title">Assignments</h4>
              <div className="stack" style={{ gap: 8 }}>
                {assignments.map((a) => (
                  <div key={a.id} className="row between" style={{ fontSize: 13 }}>
                    <span>
                      <b>{a.agentName}</b>{' '}
                      <span className="muted">
                        · {a.mode} · {a.distanceKm?.toFixed(2)} km · {clockTime(a.offeredAt)}
                      </span>
                    </span>
                    <StatusBadge status={a.status} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h4 className="section-title">Audit timeline</h4>
            <div className="timeline">
              {timeline.map((e) => (
                <div key={e.id} className="timeline-item" style={{ ['--c' as string]: EVENT_COLOR[e.action] ?? 'var(--accent)' }}>
                  {describeEvent(e)}
                  <small>
                    {clockTime(e.createdAt)} · {e.actor.role === 'system' ? 'system' : `${e.actor.name} (${e.actor.role})`}
                    {e.from && e.to ? ` · ${e.from} → ${e.to}` : ''}
                  </small>
                </div>
              ))}
            </div>
          </section>
        </div>

        {cancellable && (
          <div className="drawer-foot">
            {cancelling ? (
              <>
                <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                <button className="btn btn-ghost" onClick={() => setCancelling(false)}>
                  Back
                </button>
                <button className="btn btn-danger" disabled={reason.trim().length < 3 || busy !== null} onClick={cancel}>
                  Confirm cancel
                </button>
              </>
            ) : (
              <>
                {assignable && (
                  <button className="btn btn-primary" disabled={busy !== null} onClick={autoDispatch}>
                    <BoltIcon size={14} /> {request.status === 'pending' ? 'Auto-dispatch' : 'Reassign automatically'}
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <button className="btn btn-danger" onClick={() => setCancelling(true)}>
                  Cancel request
                </button>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
