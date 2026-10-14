import { useMemo, useState } from 'react';
import { timeAgo, titleCase } from '../lib/format';
import { OPEN_STATUSES, type ServiceRequest } from '../lib/types';
import { PriorityTag, StatusBadge, useNow } from './ui';

type Filter = 'active' | 'pending' | 'closed' | 'all';

const FILTERS: { key: Filter; label: string; match: (r: ServiceRequest) => boolean }[] = [
  { key: 'active', label: 'Active', match: (r) => OPEN_STATUSES.includes(r.status) },
  { key: 'pending', label: 'Unassigned', match: (r) => r.status === 'pending' },
  { key: 'closed', label: 'Closed', match: (r) => !OPEN_STATUSES.includes(r.status) },
  { key: 'all', label: 'All', match: () => true },
];

interface Props {
  requests: ServiceRequest[];
  selectedId: string | null;
  recentlyChanged: Set<string>;
  onSelect: (id: string) => void;
}

export function RequestsTable({ requests, selectedId, recentlyChanged, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('active');
  const now = useNow(5000);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, requests.filter(f.match).length])) as Record<Filter, number>,
    [requests],
  );

  const rows = useMemo(() => {
    const match = FILTERS.find((f) => f.key === filter)!.match;
    return requests
      .filter(match)
      .sort((a, b) =>
        filter === 'closed'
          ? b.updatedAt.localeCompare(a.updatedAt)
          : b.priorityRank - a.priorityRank || b.createdAt.localeCompare(a.createdAt),
      );
  }, [requests, filter]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Service requests<span className="count">{requests.length}</span>
        </h2>
        <div className="segmented" role="group" aria-label="Filter requests">
          {FILTERS.map((f) => (
            <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              <span className="count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No requests here yet. Create one or run the simulator.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Agent</th>
                <th className="hide-sm">Category</th>
                <th className="hide-sm">Offers</th>
                <th className="hide-sm">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.id}-${recentlyChanged.has(r.id) ? r.updatedAt : ''}`}
                  className={`${r.id === selectedId ? 'selected' : ''} ${recentlyChanged.has(r.id) ? 'flash' : ''}`}
                  onClick={() => onSelect(r.id)}
                >
                  <td>
                    <div className="title">{r.title}</div>
                    <div className="sub mono">{r.code}</div>
                  </td>
                  <td>
                    <PriorityTag priority={r.priority} />
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="nowrap">{r.assignedAgentName ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">
                    <span className="tag">{titleCase(r.category)}</span>
                  </td>
                  <td className="hide-sm mono">{r.attempts}</td>
                  <td className="hide-sm muted nowrap">{timeAgo(r.createdAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
