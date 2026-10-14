import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { PRIORITY_LABEL, STATUS_LABEL } from '../lib/format';
import type { AssignmentStatus, Priority, RequestStatus } from '../lib/types';

export function StatusBadge({ status }: { status: RequestStatus | AssignmentStatus }) {
  const live = status === 'pending' || status === 'offered';
  return <span className={`badge st-${status}${live ? ' pulse' : ''}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return <span className={`prio pr-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}

/** Re-renders every `ms` so relative times and countdowns stay fresh. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Countdown({ from, to }: { from: string; to: string }) {
  const now = useNow(250);
  const total = new Date(to).getTime() - new Date(from).getTime();
  const left = Math.max(0, new Date(to).getTime() - now);
  const pct = total > 0 ? (left / total) * 100 : 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className={`countdown${pct < 30 ? ' low' : ''}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="row between muted" style={{ fontSize: 12 }}>
        <span>Respond before the offer expires</span>
        <span className="mono">{Math.ceil(left / 1000)}s</span>
      </div>
    </div>
  );
}

/* --------------------------------- Toasts --------------------------------- */

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <strong>{t.title}</strong>
            {t.body && <span className="muted">{t.body}</span>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------------------------------- Icons --------------------------------- */

const icon = (path: ReactNode) =>
  function Icon({ size = 16 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {path}
      </svg>
    );
  };

export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const CloseIcon = icon(<path d="M18 6 6 18M6 6l12 12" />);
export const RefreshIcon = icon(
  <>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </>,
);
export const BoltIcon = icon(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />);
export const PinIcon = icon(
  <>
    <path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z" />
    <circle cx="12" cy="10" r="2.5" />
  </>,
);
export const LogoutIcon = icon(
  <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </>,
);
export const ShieldIcon = icon(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
export const RadarIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 12 19 5" />
  </>,
);
export const ClockIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const SettingsIcon = icon(
  <>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </>,
);
export const DocsIcon = icon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h5" />
  </>,
);

export function BrandMark() {
  return (
    <span className="brand-mark">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.4} aria-hidden>
        <circle cx="12" cy="12" r="3" fill="white" />
        <circle cx="12" cy="12" r="8" strokeOpacity={0.6} />
      </svg>
    </span>
  );
}
