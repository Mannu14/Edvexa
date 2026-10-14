import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one broken widget from blanking the whole console. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ paddingTop: '20vh' }}>
        <h2 style={{ color: 'var(--text)' }}>Something went wrong</h2>
        <p>{this.state.error.message}</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
