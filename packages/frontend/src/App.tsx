import { useEffect, useState } from 'react';
import type { HealthResponse, RuntimeConfig } from '@activity-racer/shared';
import { loadRuntimeConfig } from './config';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; config: RuntimeConfig; health: HealthResponse }
  | { status: 'error'; message: string };

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const checkHealth = async () => {
    setState({ status: 'loading' });
    try {
      const config = await loadRuntimeConfig();
      const res = await fetch(`${config.apiUrl}/health`);
      if (!res.ok) {
        throw new Error(`Health endpoint returned HTTP ${res.status}`);
      }
      const health = (await res.json()) as HealthResponse;
      setState({ status: 'ready', config, health });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  useEffect(() => {
    void checkHealth();
  }, []);

  return (
    <main className="page">
      <section className="card">
        <span className="badge">Phase 1 · Walking Skeleton</span>
        <h1>Activity Racer</h1>
        <p className="subtitle">
          End-to-end check: Private S3 SPA → HTTPS API Gateway → AWS Lambda
        </p>

        {state.status === 'loading' && (
          <div className="status status-loading">Checking API health...</div>
        )}

        {state.status === 'ready' && (
          <div className="status status-ok">
            <strong>API Connected</strong>
            <dl className="meta">
              <div>
                <dt>Service</dt>
                <dd>{state.health.service}</dd>
              </div>
              <div>
                <dt>Region</dt>
                <dd>{state.health.region}</dd>
              </div>
              {state.config.hostingMode && (
                <div>
                  <dt>SPA Hosting</dt>
                  <dd>{state.config.hostingMode}</dd>
                </div>
              )}
              <div>
                <dt>API Endpoint</dt>
                <dd>{state.config.apiUrl}</dd>
              </div>
              <div>
                <dt>Server Time</dt>
                <dd>{state.health.timestamp}</dd>
              </div>
            </dl>
          </div>
        )}

        {state.status === 'error' && (
          <div className="status status-error">
            <strong>Connection Error</strong>
            <p>{state.message}</p>
          </div>
        )}

        <button type="button" className="btn" onClick={() => void checkHealth()}>
          Re-check Health
        </button>
      </section>
    </main>
  );
}
