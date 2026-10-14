import { clockTime, describeEvent } from '../lib/format';
import type { AuditEvent } from '../lib/types';

export const EVENT_COLOR: Record<string, string> = {
  'request.created': 'var(--st-pending)',
  'request.cancelled': 'var(--st-cancelled)',
  'request.failed': 'var(--st-failed)',
  'request.updated': 'var(--muted)',
  'assignment.offered': 'var(--st-offered)',
  'assignment.accepted': 'var(--st-accepted)',
  'assignment.started': 'var(--st-progress)',
  'assignment.completed': 'var(--st-completed)',
  'assignment.rejected': 'var(--st-failed)',
  'assignment.expired': 'var(--st-pending)',
  'assignment.revoked': 'var(--st-cancelled)',
  'agent.online': 'var(--ok)',
  'agent.offline': 'var(--muted)',
};

interface Props {
  events: AuditEvent[];
  codeFor: (requestId: string | null) => string | null;
  onSelectRequest: (id: string) => void;
}

export function ActivityFeed({ events, codeFor, onSelectRequest }: Props) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Live activity</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          audit trail
        </span>
      </div>
      {events.length === 0 ? (
        <div className="empty">Waiting for events…</div>
      ) : (
        <div className="feed">
          {events.map((e) => {
            const code = codeFor(e.request);
            return (
              <div key={e.id} className="feed-item" style={{ ['--c' as string]: EVENT_COLOR[e.action] ?? 'var(--accent)' }}>
                <span className="bullet" />
                <div>
                  <div className="text">{describeEvent(e)}</div>
                  <div className="meta">
                    <span className="mono">{clockTime(e.createdAt)}</span>
                    {code && e.request && (
                      <a
                        href="#"
                        className="mono"
                        style={{ color: 'var(--accent)' }}
                        onClick={(ev) => {
                          ev.preventDefault();
                          onSelectRequest(e.request!);
                        }}
                      >
                        {code}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
