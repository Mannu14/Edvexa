import { useMemo, type MouseEvent } from 'react';
import type { Agent, LatLng, ServiceRequest } from '../lib/types';

export const CITY_CENTER: LatLng = { lat: 12.9716, lng: 77.5946 };

const W = 1600;
const H = 700;
const KM_PER_DEG = 111.2;
const COS = Math.cos((CITY_CENTER.lat * Math.PI) / 180);

const PRIORITY_COLOR: Record<string, string> = {
  low: 'var(--pr-low)',
  normal: 'var(--pr-normal)',
  high: 'var(--pr-high)',
  critical: 'var(--pr-critical)',
};
const LINK_COLOR: Record<string, string> = {
  offered: 'var(--st-offered)',
  accepted: 'var(--st-accepted)',
  in_progress: 'var(--st-progress)',
};

const toKm = (p: LatLng) => ({ x: (p.lng - CITY_CENTER.lng) * KM_PER_DEG * COS, y: (p.lat - CITY_CENTER.lat) * KM_PER_DEG });

interface Props {
  agents: Agent[];
  requests: ServiceRequest[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  picking?: boolean;
  picked?: LatLng | null;
  onPick?: (p: LatLng) => void;
  /** Small embedded map: no legend, taller aspect ratio. */
  compact?: boolean;
}

/**
 * Lightweight operational map: an equirectangular projection around the city
 * centre rendered as SVG. No tile server or paid map API is needed.
 */
export function MapView({ agents, requests, selectedId, onSelect, picking, picked, onPick, compact }: Props) {
  // Fit all points, snapping the extent to 2 km steps so the view does not jitter as agents move.
  const scale = useMemo(() => {
    const pts = [...agents.map((a) => a.location), ...requests.map((r) => r.location)].map(toKm);
    const ex = Math.ceil((Math.max(6, ...pts.map((p) => Math.abs(p.x))) * 1.15) / 2) * 2;
    const ey = Math.ceil((Math.max(3, ...pts.map((p) => Math.abs(p.y))) * 1.15) / 2) * 2;
    return Math.min(W / 2 / ex, H / 2 / ey);
  }, [agents, requests]);

  const project = (p: LatLng) => {
    const k = toKm(p);
    return { x: W / 2 + k.x * scale, y: H / 2 - k.y * scale };
  };

  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!picking || !onPick) return;
    // Account for preserveAspectRatio="slice" cropping on narrow screens.
    const rect = e.currentTarget.getBoundingClientRect();
    const s = Math.max(rect.width / W, rect.height / H);
    const px = (e.clientX - rect.left - (rect.width - W * s) / 2) / s;
    const py = (e.clientY - rect.top - (rect.height - H * s) / 2) / s;
    const kmX = (px - W / 2) / scale;
    const kmY = (H / 2 - py) / scale;
    onPick({
      lat: Math.round((CITY_CENTER.lat + kmY / KM_PER_DEG) * 1e5) / 1e5,
      lng: Math.round((CITY_CENTER.lng + kmX / (KM_PER_DEG * COS)) * 1e5) / 1e5,
    });
  };

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const gridStep = 2 * scale; // 2 km grid
  const gridX = Array.from({ length: Math.ceil(W / 2 / gridStep) }, (_, i) => i * gridStep);
  const gridY = Array.from({ length: Math.ceil(H / 2 / gridStep) }, (_, i) => i * gridStep);

  return (
    <div className="map-wrap">
      <svg
        className={`map${picking ? ' picking' : ''}${compact ? ' compact' : ''}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio={compact ? 'xMidYMid meet' : 'xMidYMid slice'}
        onClick={handleClick}
        role="img"
        aria-label="Map of agents and service requests"
      >
        <g className="grid">
          {gridX.flatMap((d) => [W / 2 + d, W / 2 - d]).map((x, i) => (
            <line key={`x${i}`} x1={x} x2={x} y1={0} y2={H} />
          ))}
          {gridY.flatMap((d) => [H / 2 + d, H / 2 - d]).map((y, i) => (
            <line key={`y${i}`} y1={y} y2={y} x1={0} x2={W} />
          ))}
        </g>

        {[2, 5, 10].map((km) => (
          <g key={km}>
            <circle className="ring" cx={W / 2} cy={H / 2} r={km * scale} />
            <text className="ring-label" x={W / 2 + km * scale * 0.707 + 6} y={H / 2 - km * scale * 0.707 - 6}>
              {km} km
            </text>
          </g>
        ))}

        {requests.map((r) => {
          const agent = r.assignedAgent ? agentById.get(r.assignedAgent) : undefined;
          if (!agent || !LINK_COLOR[r.status]) return null;
          const a = project(agent.location);
          const b = project(r.location);
          return (
            <line
              key={`l-${r.id}`}
              className="link"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={LINK_COLOR[r.status]}
              strokeDasharray={r.status === 'offered' ? '6 6' : undefined}
              strokeOpacity={0.85}
            />
          );
        })}

        {agents.map((a) => {
          const p = project(a.location);
          const fill = a.status === 'offline' ? '#4a5564' : a.available ? 'var(--ok)' : 'var(--warn)';
          return (
            <g key={a.id} opacity={a.status === 'offline' ? 0.55 : 1}>
              <circle className="agent-dot" cx={p.x} cy={p.y} r={12} fill={fill}>
                <title>
                  {a.name} - {a.status}
                  {a.status === 'online' ? ` (${a.activeCount}/${a.maxConcurrent})` : ''}
                </title>
              </circle>
              <text className="label" x={p.x + 18} y={p.y + 6}>
                {a.name.split(' ')[0]}
              </text>
            </g>
          );
        })}

        {requests.map((r) => {
          const p = project(r.location);
          const color = PRIORITY_COLOR[r.priority];
          const selected = r.id === selectedId;
          return (
            <g
              key={r.id}
              className="req"
              onClick={(e) => {
                e.stopPropagation();
                onSelect?.(r.id);
              }}
            >
              {r.status === 'pending' && <circle className="req-halo" cx={p.x} cy={p.y} r={18} fill={color} />}
              {selected && <circle cx={p.x} cy={p.y} r={28} fill="none" stroke="white" strokeOpacity={0.8} strokeWidth={2} />}
              <rect
                x={p.x - 11}
                y={p.y - 11}
                width={22}
                height={22}
                rx={3.5}
                fill={color}
                stroke="#0a0d12"
                strokeWidth={2}
                transform={`rotate(45 ${p.x} ${p.y})`}
              >
                <title>
                  {r.code} - {r.title} ({r.status})
                </title>
              </rect>
            </g>
          );
        })}

        {picked && (
          <g pointerEvents="none">
            {(() => {
              const p = project(picked);
              return (
                <>
                  <circle cx={p.x} cy={p.y} r={16} fill="var(--accent)" fillOpacity={0.2} stroke="var(--accent)" />
                  <circle cx={p.x} cy={p.y} r={4} fill="var(--accent)" />
                </>
              );
            })()}
          </g>
        )}
      </svg>

      {picking && <div className="map-hint">Click on the map to set the request location</div>}

      <div className="map-legend" hidden={compact}>
        <span>
          <i style={{ background: 'var(--ok)' }} /> Available
        </span>
        <span>
          <i style={{ background: 'var(--warn)' }} /> Busy
        </span>
        <span>
          <i style={{ background: '#4a5564' }} /> Offline
        </span>
        <span>
          <i className="sq" style={{ background: 'var(--pr-critical)' }} /> Request (by priority)
        </span>
      </div>
    </div>
  );
}
