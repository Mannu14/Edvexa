import { useMemo } from 'react';
import { timeAgo, titleCase } from '../lib/format';
import type { Agent } from '../lib/types';
import { useNow } from './ui';

export function AgentsPanel({ agents }: { agents: Agent[] }) {
  const now = useNow(5000);
  const sorted = useMemo(
    () =>
      [...agents].sort(
        (a, b) =>
          Number(b.status === 'online') - Number(a.status === 'online') ||
          Number(b.available) - Number(a.available) ||
          a.name.localeCompare(b.name),
      ),
    [agents],
  );
  const available = agents.filter((a) => a.available).length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Agents<span className="count">{available} available</span>
        </h2>
      </div>
      {sorted.length === 0 ? (
        <div className="empty">No agents yet.</div>
      ) : (
        <div className="agent-list">
          {sorted.map((a) => {
            const state = a.status === 'offline' ? 'offline' : a.available ? 'available' : 'busy';
            return (
              <div key={a.id} className="agent-row">
                <span className={`dot ${state}`} aria-label={state} />
                <div>
                  <div className="name">{a.name}</div>
                  <div className="skills">
                    {a.skills.map((s) => (
                      <span key={s} className="tag">
                        {titleCase(s)}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`badge st-${state === 'available' ? 'online' : state}`}>
                    {state === 'available' ? 'Available' : state === 'busy' ? 'Busy' : 'Offline'}
                  </span>
                  {a.status === 'online' ? (
                    <div className="load" title={`${a.activeCount} of ${a.maxConcurrent} slots in use`}>
                      {Array.from({ length: a.maxConcurrent }, (_, i) => (
                        <i key={i} className={i < a.activeCount ? 'on' : ''} />
                      ))}
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                      seen {timeAgo(a.lastSeenAt, now)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
