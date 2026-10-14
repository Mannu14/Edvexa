import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, newIdempotencyKey } from '../lib/api';
import { PRIORITY_LABEL, titleCase } from '../lib/format';
import { CATEGORIES, PRIORITIES, type Category, type DispatchOutcome, type LatLng, type Priority, type ServiceRequest } from '../lib/types';
import { CITY_CENTER } from './MapView';
import { PinIcon, useToast } from './ui';

interface Props {
  location: LatLng | null;
  onPickOnMap: () => void;
  onClose: () => void;
  onCreated: (r: ServiceRequest) => void;
}

const randomNearby = (): LatLng => ({
  lat: Math.round((CITY_CENTER.lat + (Math.random() - 0.5) * 0.08) * 1e5) / 1e5,
  lng: Math.round((CITY_CENTER.lng + (Math.random() - 0.5) * 0.08) * 1e5) / 1e5,
});

export function CreateRequestModal({ location, onPickOnMap, onClose, onCreated }: Props) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category>('repair');
  const [priority, setPriority] = useState<Priority>('normal');
  const [address, setAddress] = useState('');
  const [loc, setLoc] = useState<LatLng | null>(location);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per form: double-clicks and network retries can never create duplicates.
  const [idemKey] = useState(newIdempotencyKey);

  // A location picked on the map replaces whatever was set before.
  useEffect(() => {
    if (location) setLoc(location);
  }, [location]);
  const effectiveLoc = loc;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!effectiveLoc) return setError('Pick a location on the map or use a random nearby one.');
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ request: ServiceRequest; dispatch: DispatchOutcome }>('/requests', {
        method: 'POST',
        idempotencyKey: idemKey,
        body: { title, description: description || undefined, category, priority, address: address || undefined, location: effectiveLoc },
      });
      const outcome =
        res.dispatch.outcome === 'offered'
          ? `Offered to ${res.dispatch.assignment?.agentName}`
          : res.dispatch.outcome === 'waiting'
            ? 'Queued — no eligible agent right now'
            : titleCase(res.dispatch.outcome);
      toast({ kind: 'success', title: `${res.request.code} created`, body: outcome });
      onCreated(res.request);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create request');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="modal" onSubmit={submit} aria-labelledby="create-title">
        <div className="modal-head">
          <h3 id="create-title">New service request</h3>
          <p>Auto-dispatch picks the best agent by distance, workload and fairness.</p>
        </div>
        <div className="modal-body">
          {error && <div className="form-error">{error}</div>}
          <label className="field">
            <span>Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. AC not cooling" required minLength={3} maxLength={140} autoFocus />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Category</span>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {titleCase(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Priority</span>
              <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Address (optional)</span>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Flat 4B, Indiranagar" maxLength={300} />
          </label>
          <div className="field">
            <span>Location</span>
            <div className="location-pick">
              <div className="coords mono">
                {effectiveLoc ? `${effectiveLoc.lat.toFixed(5)}, ${effectiveLoc.lng.toFixed(5)}` : 'Not set'}
              </div>
              <button type="button" className="btn btn-sm" onClick={onPickOnMap}>
                <PinIcon size={14} /> Pick on map
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLoc(randomNearby())}>
                Random
              </button>
            </div>
          </div>
          <label className="field">
            <span>Notes (optional)</span>
            <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create & dispatch'}
          </button>
        </div>
      </form>
    </>
  );
}
