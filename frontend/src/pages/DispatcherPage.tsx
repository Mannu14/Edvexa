import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ActivityFeed } from '../components/ActivityFeed';
import { AgentsPanel } from '../components/AgentsPanel';
import { ConfigPanel } from '../components/ConfigPanel';
import { CreateRequestModal } from '../components/CreateRequestModal';
import { MapView } from '../components/MapView';
import { RequestDrawer } from '../components/RequestDrawer';
import { RequestsTable } from '../components/RequestsTable';
import { TopBar } from '../components/TopBar';
import { PlusIcon, SettingsIcon } from '../components/ui';
import { api } from '../lib/api';
import { useSocket } from '../lib/socket';
import { OPEN_STATUSES, type Agent, type AuditEvent, type LatLng, type ServiceRequest, type Summary } from '../lib/types';

const upsert = <T extends { id: string }>(map: Map<string, T>, item: T) => new Map(map).set(item.id, item);

/** Loads the dashboard snapshot and keeps it current from Socket.IO events. */
function useDispatchData(token: string | null) {
  const [requests, setRequests] = useState<Map<string, ServiceRequest>>(new Map());
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [feed, setFeed] = useState<AuditEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const summaryTimer = useRef<number>();

  const refreshSummary = useCallback(() => {
    window.clearTimeout(summaryTimer.current);
    summaryTimer.current = window.setTimeout(() => {
      api<Summary>('/dashboard/summary').then(setSummary).catch(() => undefined);
    }, 400);
  }, []);

  const load = useCallback(async () => {
    const [open, recent, agentList, sum, audit] = await Promise.all([
      api<{ data: ServiceRequest[] }>(`/requests?status=${OPEN_STATUSES.join(',')}&limit=100`),
      api<{ data: ServiceRequest[] }>('/requests?status=completed,cancelled,failed&limit=40'),
      api<{ data: Agent[] }>('/agents'),
      api<Summary>('/dashboard/summary'),
      api<{ data: AuditEvent[] }>('/audit?limit=40'),
    ]);
    setRequests(new Map([...recent.data, ...open.data].map((r) => [r.id, r])));
    setAgents(new Map(agentList.data.map((a) => [a.id, a])));
    setSummary(sum);
    setFeed(audit.data);
  }, []);

  const markChanged = (id: string) => {
    setChanged((s) => new Set(s).add(id));
    window.setTimeout(
      () =>
        setChanged((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      1300,
    );
  };

  const { state } = useSocket(token, {
    connect: () => void load().catch(() => undefined),
    'request:updated': (r: ServiceRequest) => {
      setRequests((m) => upsert(m, r));
      markChanged(r.id);
      refreshSummary();
    },
    'agent:updated': (a: Agent) => {
      setAgents((m) => upsert(m, a));
      refreshSummary();
    },
    'audit:event': (e: AuditEvent) => setFeed((f) => [e, ...f.filter((x) => x.id !== e.id)].slice(0, 80)),
  });

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  return { requests, agents, feed, summary, changed, connection: state, setRequests };
}

export function DispatcherPage() {
  const { token, user } = useAuth();
  const { requests, agents, feed, summary, changed, connection, setRequests } = useDispatchData(token);
  const [tab, setTab] = useState<'ops' | 'rules'>('ops');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<LatLng | null>(null);

  const requestList = useMemo(() => [...requests.values()], [requests]);
  const agentList = useMemo(() => [...agents.values()], [agents]);
  const openRequests = useMemo(() => requestList.filter((r) => OPEN_STATUSES.includes(r.status)), [requestList]);
  const selected = selectedId ? requests.get(selectedId) ?? null : null;

  const openCreate = () => {
    setPicked(null);
    setCreating(true);
  };

  const kpis = summary
    ? [
        { label: 'Unassigned', value: summary.requests.pending, sub: 'waiting in queue', c: 'var(--st-pending)' },
        { label: 'Awaiting response', value: summary.requests.offered, sub: 'offers out', c: 'var(--st-offered)' },
        {
          label: 'In service',
          value: summary.requests.accepted + summary.requests.in_progress,
          sub: `${summary.requests.in_progress} on site`,
          c: 'var(--st-progress)',
        },
        { label: 'Completed', value: summary.requests.completed, sub: `${summary.requests.failed} failed · ${summary.requests.cancelled} cancelled`, c: 'var(--st-completed)' },
        { label: 'Agents available', value: summary.agents.available, sub: `${summary.agents.online} online / ${summary.agents.total}`, c: 'var(--ok)' },
        {
          label: 'Acceptance (24h)',
          value: summary.last24h.acceptanceRate === null ? '—' : `${summary.last24h.acceptanceRate}%`,
          sub: `${summary.last24h.rejected} rejected · ${summary.last24h.expired} timed out`,
          c: 'var(--st-accepted)',
        },
      ]
    : [];

  return (
    <div className="shell">
      <TopBar connection={connection} subtitle={user?.role === 'admin' ? 'Admin' : 'Dispatcher'} />
      <main className="page">
        <div className="page-head">
          <div>
            <h1>Operations</h1>
            <p>Live view of service requests, agent availability and dispatch decisions.</p>
          </div>
          <div className="actions">
            <div className="segmented" role="tablist">
              <button aria-pressed={tab === 'ops'} onClick={() => setTab('ops')}>
                Live board
              </button>
              <button aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>
                <SettingsIcon size={13} /> Dispatch rules
              </button>
            </div>
            <button className="btn btn-primary" onClick={openCreate}>
              <PlusIcon size={15} /> New request
            </button>
          </div>
        </div>

        {tab === 'rules' ? (
          <ConfigPanel editable={user?.role === 'admin'} />
        ) : (
          <>
            <div className="kpis">
              {kpis.map((k) => (
                <div key={k.label} className="panel kpi" style={{ ['--c' as string]: k.c }}>
                  <div className="label">{k.label}</div>
                  <div className="value">{k.value}</div>
                  <div className="sub">{k.sub}</div>
                </div>
              ))}
            </div>

            <div className="dash">
              <div className="dash-main">
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      Live map<span className="count">{openRequests.length} open</span>
                    </h2>
                    <span className="muted" style={{ fontSize: 12 }}>
                      dashed = offered · solid = accepted / on site
                    </span>
                  </div>
                  <MapView
                    agents={agentList}
                    requests={openRequests}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    picking={picking}
                    picked={creating ? picked : null}
                    onPick={(p) => {
                      setPicked(p);
                      setPicking(false);
                    }}
                  />
                </section>
                <RequestsTable requests={requestList} selectedId={selectedId} recentlyChanged={changed} onSelect={setSelectedId} />
              </div>
              <div className="dash-side">
                <AgentsPanel agents={agentList} />
                <ActivityFeed events={feed} codeFor={(id) => (id ? requests.get(id)?.code ?? null : null)} onSelectRequest={setSelectedId} />
              </div>
            </div>
          </>
        )}
      </main>

      {creating && (
        <div hidden={picking}>
          <CreateRequestModal
            location={picked}
            onPickOnMap={() => {
              setTab('ops');
              setPicking(true);
            }}
            onClose={() => {
              setCreating(false);
              setPicking(false);
            }}
            onCreated={(r) => {
              setRequests((m) => new Map(m).set(r.id, r));
              setCreating(false);
              setSelectedId(r.id);
            }}
          />
        </div>
      )}

      {selected && !creating && <RequestDrawer request={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
