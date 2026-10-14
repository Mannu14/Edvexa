import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { MapView } from '../components/MapView';
import { TopBar } from '../components/TopBar';
import { Countdown, PriorityTag, StatusBadge, useNow, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { timeAgo, titleCase } from '../lib/format';
import { useSocket } from '../lib/socket';
import type { Agent, Assignment, LatLng } from '../lib/types';

const HEARTBEAT_MS = 5000;

export function AgentPage() {
  const { token } = useAuth();
  const toast = useToast();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [active, setActive] = useState<Assignment[]>([]);
  const [history, setHistory] = useState<Assignment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(true);
  const [lastBeat, setLastBeat] = useState<number | null>(null);
  const location = useRef<LatLng | null>(null);
  const now = useNow(1000);

  const load = useCallback(async () => {
    const [me, act, all] = await Promise.all([
      api<{ agent: Agent }>('/agents/me'),
      api<{ data: Assignment[] }>('/agents/me/assignments'),
      api<{ data: Assignment[] }>('/agents/me/assignments?active=false'),
    ]);
    setAgent(me.agent);
    location.current ??= me.agent.location;
    setActive(act.data);
    setHistory(all.data.filter((a) => !a.active).slice(0, 12));
  }, []);

  const { socket, state } = useSocket(token, {
    connect: () => void load().catch(() => undefined),
    'assignment:offered': (p: { request: { code: string; title: string } }) => {
      toast({ kind: 'info', title: `New offer ${p.request.code}`, body: p.request.title });
      void load();
    },
    'assignment:updated': () => void load(),
    'agent:updated': (a: Agent) => setAgent(a),
  });

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const online = agent?.status === 'online';

  // Heartbeat loop: keeps presence alive (and reports position) while online.
  useEffect(() => {
    if (!online) return;
    const beat = async () => {
      if (moving && location.current) {
        location.current = {
          lat: location.current.lat + (Math.random() - 0.5) * 0.002,
          lng: location.current.lng + (Math.random() - 0.5) * 0.002,
        };
      }
      const payload = { location: location.current ?? undefined };
      try {
        if (socket?.connected) await socket.timeout(4000).emitWithAck('agent:heartbeat', payload);
        else await api('/agents/me/heartbeat', { method: 'POST', body: payload });
        setLastBeat(Date.now());
      } catch {
        /* next beat retries; the server tolerates missed beats until the TTL */
      }
    };
    void beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [online, socket, moving]);

  const toggleOnline = async () => {
    setBusy('presence');
    try {
      const r = await api<{ agent: Agent }>('/agents/me/status', {
        method: 'POST',
        body: { status: online ? 'offline' : 'online', location: location.current ?? undefined },
      });
      setAgent(r.agent);
      if (online) toast({ kind: 'info', title: 'You are offline', body: 'Pending offers were returned to the queue.' });
      await load();
    } catch (err) {
      toast({ kind: 'error', title: 'Could not change status', body: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const act = async (a: Assignment, step: 'accept' | 'reject' | 'start' | 'complete') => {
    setBusy(`${a.id}:${step}`);
    try {
      await api(`/assignments/${a.id}/${step}`, { method: 'POST', body: step === 'reject' ? { reason: 'Declined from agent console' } : undefined });
      const verb = { accept: 'Accepted', reject: 'Rejected', start: 'Started', complete: 'Completed' }[step];
      toast({ kind: step === 'reject' ? 'info' : 'success', title: `${verb} ${a.requestDetail?.code ?? ''}` });
    } catch (err) {
      toast({ kind: 'error', title: 'Action failed', body: err instanceof ApiError ? `${err.code}: ${err.message}` : String(err) });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const offers = active.filter((a) => a.status === 'offered');
  const jobs = active.filter((a) => a.status !== 'offered');

  return (
    <div className="shell">
      <TopBar connection={state} subtitle="Agent console" />
      <main className="page">
        <div className="page-head">
          <div>
            <h1>Hi, {agent?.name.split(' ')[0] ?? 'there'}</h1>
            <p>Stay online to receive offers. Unanswered offers expire and go to the next agent.</p>
          </div>
        </div>

        <div className="agent-grid">
          <aside className="presence">
            <section className="panel panel-body stack">
              <div className="presence-switch">
                <div>
                  <div className="state" style={{ color: online ? 'var(--ok)' : 'var(--muted)' }}>
                    {online ? 'Online' : 'Offline'}
                  </div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {online ? `Last heartbeat ${lastBeat ? timeAgo(new Date(lastBeat).toISOString(), now) : 'starting…'}` : 'Not receiving offers'}
                  </div>
                </div>
                <button className="switch" role="switch" aria-checked={online} aria-label="Toggle availability" disabled={busy === 'presence' || !agent} onClick={toggleOnline} />
              </div>

              {agent && (
                <>
                  <div className="stat-grid">
                    <div className="stat">
                      <b>
                        {agent.activeCount}/{agent.maxConcurrent}
                      </b>
                      <small>Load</small>
                    </div>
                    <div className="stat">
                      <b>{agent.stats.completed}</b>
                      <small>Completed</small>
                    </div>
                    <div className="stat">
                      <b>{agent.stats.offered ? Math.round((agent.stats.accepted / agent.stats.offered) * 100) : 0}%</b>
                      <small>Accept rate</small>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {agent.skills.map((s) => (
                      <span key={s} className="tag">
                        {titleCase(s)}
                      </span>
                    ))}
                  </div>
                  <label className="row muted" style={{ fontSize: 12.5, cursor: 'pointer', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} />
                    Simulate movement (location drifts with each heartbeat)
                  </label>
                </>
              )}
            </section>

            {agent && (
              <section className="panel">
                <div className="panel-head">
                  <h2>My position</h2>
                  <span className="mono muted">
                    {agent.location.lat.toFixed(4)}, {agent.location.lng.toFixed(4)}
                  </span>
                </div>
                <MapView compact agents={[agent]} requests={active.map((a) => a.requestDetail!).filter(Boolean)} />
              </section>
            )}
          </aside>

          <div className="stack" style={{ gap: 16 }}>
            {offers.map((a) => (
              <div key={a.id} className="offer-card">
                <div className="job-head">
                  <div>
                    <div className="row">
                      <span className="mono muted">{a.requestDetail?.code}</span>
                      <StatusBadge status="offered" />
                      {a.requestDetail && <PriorityTag priority={a.requestDetail.priority} />}
                    </div>
                    <h3 style={{ marginTop: 6 }}>{a.requestDetail?.title}</h3>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {titleCase(a.requestDetail?.category ?? '')} · {a.distanceKm?.toFixed(2)} km away
                      {a.requestDetail?.address ? ` · ${a.requestDetail.address}` : ''}
                    </div>
                  </div>
                </div>
                <Countdown from={a.offeredAt} to={a.expiresAt} />
                <div className="row">
                  <button className="btn btn-success" disabled={busy !== null} onClick={() => act(a, 'accept')}>
                    Accept job
                  </button>
                  <button className="btn btn-danger" disabled={busy !== null} onClick={() => act(a, 'reject')}>
                    Reject
                  </button>
                </div>
              </div>
            ))}

            <section className="panel">
              <div className="panel-head">
                <h2>
                  Current jobs<span className="count">{jobs.length}</span>
                </h2>
              </div>
              <div className="panel-body stack">
                {jobs.length === 0 && <div className="empty">{online ? 'No active jobs. Offers will appear here instantly.' : 'Go online to start receiving offers.'}</div>}
                {jobs.map((a) => (
                  <div key={a.id} className="job-card">
                    <div className="job-head">
                      <div>
                        <div className="row">
                          <span className="mono muted">{a.requestDetail?.code}</span>
                          <StatusBadge status={a.status} />
                        </div>
                        <b style={{ display: 'block', marginTop: 4 }}>{a.requestDetail?.title}</b>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          {a.requestDetail?.address || `${a.distanceKm?.toFixed(2)} km away`}
                        </span>
                      </div>
                      {a.status === 'accepted' && (
                        <button className="btn btn-primary" disabled={busy !== null} onClick={() => act(a, 'start')}>
                          Start job
                        </button>
                      )}
                      {a.status === 'in_progress' && (
                        <button className="btn btn-success" disabled={busy !== null} onClick={() => act(a, 'complete')}>
                          Mark complete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Recent history</h2>
              </div>
              {history.length === 0 ? (
                <div className="empty">Nothing yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {history.map((a) => (
                        <tr key={a.id} style={{ cursor: 'default' }}>
                          <td>
                            <div className="title">{a.requestDetail?.title}</div>
                            <div className="sub mono">{a.requestDetail?.code}</div>
                          </td>
                          <td>
                            <StatusBadge status={a.status} />
                          </td>
                          <td className="muted hide-sm">{a.endReason?.replace(/_/g, ' ').toLowerCase()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
