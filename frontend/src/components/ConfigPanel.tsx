import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { PRIORITY_LABEL, timeAgo } from '../lib/format';
import { PRIORITIES, type DispatchConfig, type Priority } from '../lib/types';
import { useToast } from './ui';

export function ConfigPanel({ editable }: { editable: boolean }) {
  const toast = useToast();
  const [config, setConfig] = useState<DispatchConfig | null>(null);
  const [draft, setDraft] = useState<DispatchConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ config: DispatchConfig }>('/config/dispatch').then((r) => {
      setConfig(r.config);
      setDraft(r.config);
    });
  }, []);

  if (!draft || !config) return <div className="panel empty">Loading dispatch rules…</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const set = <K extends keyof DispatchConfig>(k: K, v: DispatchConfig[K]) => setDraft({ ...draft, [k]: v });
  const setWeight = (k: keyof DispatchConfig['weights'], v: number) => set('weights', { ...draft.weights, [k]: v });
  const setRule = (p: Priority, k: 'radiusMultiplier' | 'offerTimeoutSec', v: number) =>
    set('priorityRules', { ...draft.priorityRules, [p]: { ...draft.priorityRules[p], [k]: v } });

  const save = async () => {
    setSaving(true);
    try {
      const { autoDispatch, maxRadiusKm, candidateLimit, maxAttempts, maxPendingSec, weights, priorityRules } = draft;
      const r = await api<{ config: DispatchConfig }>('/config/dispatch', {
        method: 'PUT',
        body: { autoDispatch, maxRadiusKm, candidateLimit, maxAttempts, maxPendingSec, weights, priorityRules },
      });
      setConfig(r.config);
      setDraft(r.config);
      toast({ kind: 'success', title: 'Dispatch rules saved', body: 'New rules apply to the next dispatch decision.' });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not save', body: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const num = (value: number, onChange: (v: number) => void, step = 1) => (
    <input className="input" type="number" value={value} step={step} disabled={!editable} onChange={(e) => onChange(Number(e.target.value))} />
  );
  const weightSum = draft.weights.distance + draft.weights.workload + draft.weights.fairness || 1;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Dispatch rules
          <span className="count">
            {config.updatedBy ? `updated by ${config.updatedBy} ${timeAgo(config.updatedAt)}` : 'defaults'}
          </span>
        </h2>
        {editable ? (
          <div className="row">
            <button className="btn btn-ghost btn-sm" disabled={!dirty || saving} onClick={() => setDraft(config)}>
              Reset
            </button>
            <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            Read-only · admins can edit
          </span>
        )}
      </div>
      <div className="panel-body config-grid">
        <div className="stack" style={{ gap: 18 }}>
          <div className="presence-switch">
            <div>
              <b>Automatic dispatch</b>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Offer new and re-queued requests to the best agent automatically.
              </div>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={draft.autoDispatch}
              disabled={!editable}
              onClick={() => set('autoDispatch', !draft.autoDispatch)}
              aria-label="Toggle automatic dispatch"
            />
          </div>

          <div>
            <h4 className="section-title">Scoring weights</h4>
            <div className="stack" style={{ gap: 10 }}>
              {(['distance', 'workload', 'fairness'] as const).map((k) => (
                <label key={k} className="slider-row">
                  <span style={{ textTransform: 'capitalize' }}>{k}</span>
                  <input type="range" min={0} max={1} step={0.05} value={draft.weights[k]} disabled={!editable} onChange={(e) => setWeight(k, Number(e.target.value))} />
                  <span className="mono">{Math.round((draft.weights[k] / weightSum) * 100)}%</span>
                </label>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Score = weighted mean of: closeness within the search radius, spare capacity, and time since the agent last got
              work. Weights are normalised.
            </p>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Search radius (km)</span>
              {num(draft.maxRadiusKm, (v) => set('maxRadiusKm', v), 0.5)}
            </label>
            <label className="field">
              <span>Candidates tried per dispatch</span>
              {num(draft.candidateLimit, (v) => set('candidateLimit', v))}
            </label>
            <label className="field">
              <span>Max offers per request</span>
              {num(draft.maxAttempts, (v) => set('maxAttempts', v))}
            </label>
            <label className="field">
              <span>Fail if unassigned after (s)</span>
              {num(draft.maxPendingSec, (v) => set('maxPendingSec', v), 10)}
            </label>
          </div>
        </div>

        <div>
          <h4 className="section-title">Priority rules</h4>
          <table className="table rules-table">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Radius ×</th>
                <th>Offer timeout (s)</th>
                <th>Effective radius</th>
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => (
                <tr key={p} style={{ cursor: 'default' }}>
                  <td>
                    <span className={`prio pr-${p}`}>{PRIORITY_LABEL[p]}</span>
                  </td>
                  <td>{num(draft.priorityRules[p].radiusMultiplier, (v) => setRule(p, 'radiusMultiplier', v), 0.1)}</td>
                  <td>{num(draft.priorityRules[p].offerTimeoutSec, (v) => setRule(p, 'offerTimeoutSec', v), 5)}</td>
                  <td className="mono">{(draft.maxRadiusKm * draft.priorityRules[p].radiusMultiplier).toFixed(1)} km</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Higher priorities search further and give agents less time to respond. The pending queue is always drained
            highest-priority first, then oldest first.
          </p>
        </div>
      </div>
    </section>
  );
}
