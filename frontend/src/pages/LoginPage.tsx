import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { BrandMark, ClockIcon, RadarIcon, ShieldIcon } from '../components/ui';
import { ApiError } from '../lib/api';

const DEMO = [
  { label: 'Admin', email: 'admin@dispatch.test', password: 'Admin@12345', hint: 'Edit dispatch rules, manage users' },
  { label: 'Dispatcher', email: 'dispatcher@dispatch.test', password: 'Dispatch@12345', hint: 'Create, assign and track requests' },
  { label: 'Agent', email: 'agent1@dispatch.test', password: 'Agent@12345', hint: 'Go online, accept and complete jobs' },
];

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      await login(e, p);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the API. Is the backend running on :4000?');
    } finally {
      setBusy(false);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void signIn(email, password);
  };

  return (
    <div className="login">
      <section className="login-hero">
        <div className="brand">
          <BrandMark /> Dispatch Control
        </div>
        <div>
          <h1>Real-time dispatch that never double-books.</h1>
          <p>
            Requests are matched to the best nearby agent by distance, workload and fairness, then tracked live through
            offer, acceptance and completion.
          </p>
          <div className="hero-points">
            <div className="hero-point">
              <span className="ico">
                <ShieldIcon />
              </span>
              <div>
                <b>Concurrency-safe</b>
                <span>Redis locks, atomic capacity reservation and a unique active-assignment index.</span>
              </div>
            </div>
            <div className="hero-point">
              <span className="ico">
                <RadarIcon />
              </span>
              <div>
                <b>Live presence</b>
                <span>Heartbeat-based availability with automatic offline detection and re-dispatch.</span>
              </div>
            </div>
            <div className="hero-point">
              <span className="ico">
                <ClockIcon />
              </span>
              <div>
                <b>Timeouts &amp; audit trail</b>
                <span>Unanswered offers expire and move on; every transition is recorded.</span>
              </div>
            </div>
          </div>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Synthetic demo data · Bengaluru
        </span>
      </section>

      <section className="login-form-wrap">
        <div className="login-card">
          <div>
            <h2>Sign in</h2>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Use a demo account or your own credentials.
            </p>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="demo-accounts">
            {DEMO.map((d) => (
              <button key={d.email} className="demo-account" disabled={busy} onClick={() => signIn(d.email, d.password)}>
                <span className="avatar">{d.label[0]}</span>
                <span>
                  <b>{d.label}</b>
                  <small>{d.hint}</small>
                </span>
                <span className="muted mono" style={{ fontSize: 11 }}>
                  →
                </span>
              </button>
            ))}
          </div>

          <div className="divider">or</div>

          <form className="stack" onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
