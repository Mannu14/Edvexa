import { useAuth } from './auth/AuthContext';
import { AgentPage } from './pages/AgentPage';
import { DispatcherPage } from './pages/DispatcherPage';
import { LoginPage } from './pages/LoginPage';

export function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="empty" style={{ paddingTop: '30vh' }}>Loading…</div>;
  if (!user) return <LoginPage />;
  return user.role === 'agent' ? <AgentPage /> : <DispatcherPage />;
}
